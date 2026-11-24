# Fase 2: salas, reparto y turnos

Implementa el alcance solicitado: crear y unirse a salas, elegir modalidad, repartir cartas y jugar turnos de 30 segundos con vencimiento automático. Mantiene la identidad de la fase 1, el monolito modular y PostgreSQL como fuente de estado. Los materiales académicos no se modifican.

## Probar con dos personas

1. Inicia sesión o entra como invitado en `http://127.0.0.1:5173`.
2. Crea una sala, selecciona **Clásica** o **Apuntado** y una capacidad de 2 a 6. Copia el código de ocho caracteres.
3. Abre otro navegador, perfil o ventana de incógnito para el segundo jugador. Dos pestañas normales comparten la misma sesión y representan al mismo jugador.
4. Entra con otra cuenta o invitado y usa el código. El anfitrión verá al participante sin recargar.
5. El anfitrión pulsa **Repartir y empezar**. Cada mano contiene diez cartas privadas; se sortea el primer jugador.
6. En tu turno, pulsa el mazo o **Robar del descarte**, selecciona una de tus once cartas y pulsa **Descartar carta seleccionada**. Desde la actualización del 24 de noviembre, el turno avanza solo después de dos segundos; ver ADR-10. Pulsar la pila de descarte abre el visor de consulta.
7. Deja vencer un turno o cierra el navegador de quien juega: el servidor completa el turno. Recargar con una sesión vigente recupera la misma mano, sala y fecha de vencimiento.

Una identidad solo puede estar en una sala abierta a la vez. Antes de empezar puede salir: si era anfitrión, el rol pasa al menor asiento restante; si sale el último participante, se cancela la sala. Desconectarse o cerrar sesión no equivale a salir. Durante una partida activa no se elimina a nadie por desconexión.

## Reglas operativas implementadas

- La modalidad se fija al crear la sala, usando `classic-v2` o `apuntado-v2`. No se modifica un perfil publicado ni el perfil de una partida.
- Solo el anfitrión inicia, con al menos dos jugadores y sin superar la capacidad elegida. Se rechaza el ingreso de jugadores nuevos después del inicio.
- Se generan dos mazos de 52 cartas sin comodines, identificados por copia física. Se mezclan con Fisher–Yates y `crypto.randomInt`; se reparten diez cartas por jugador y una al descarte.
- El primer jugador se sortea. Los siguientes siguen el orden de asientos, saltando huecos de la sala de espera.
- Solo el jugador del turno puede robar, descartar y pasar. La secuencia es `draw → discard → decision → draw del siguiente jugador`.
- Robar del descarte toma únicamente su carta superior. Si se agota el mazo, se mezclan los descartes anteriores y se conserva la carta superior expuesta.
- Las 104 cartas permanecen en una única ubicación. Todos conservan diez cartas, excepto el jugador que acaba de robar, que tiene once hasta descartar.

## Plazo y acción automática

Los 30 segundos son **totales**, compartidos entre robo, descarte y decisión. Las acciones parciales y las reconexiones conservan el vencimiento. El navegador muestra el tiempo usando `serverTime`, la latencia de la consulta y un reloj monotónico local; solo el servidor acepta o rechaza jugadas.

| Fase al vencer | Transición atómica                                                                 |
| -------------- | ---------------------------------------------------------------------------------- |
| `draw`         | Robar del mazo, elegir al azar una de las once cartas propias, descartarla y pasar |
| `discard`      | Elegir al azar una de las once cartas propias, descartarla y pasar                 |
| `decision`     | Pasar sin robar ni descartar de nuevo                                              |

La carta recién robada también puede ser elegida. Nunca se cierra una ronda ni se toca automáticamente. El siguiente turno recibe 30 segundos desde su transición real.

El proceso consulta los vencimientos persistidos cada 250 ms después de terminar el ciclo anterior. Esa consulta interna del servidor no es polling del juego desde el navegador. La ejecución puede demorarse por carga, base de datos o caída del proceso; el plazo sigue siendo estricto: una jugada nueva recibida al vencer o después se rechaza aunque el worker todavía no haya actuado.

Al reiniciar, el worker detecta turnos vencidos en PostgreSQL y completa uno por partida. No simula una cadena de turnos perdida durante la caída. Si todos están desconectados, la partida continúa con las acciones automáticas: todavía no se ha definido una política de cancelación por abandono.

## Integridad y reintentos

Cada comando lleva un `operationId` UUID. Los que cambian una mesa conocida incluyen `expectedVersion`; los de turno también llevan `roundNo` y `turnNo`. El cliente nunca elige el actor: se obtiene de la sesión autenticada.

Se bloquea la identidad del actor para serializar su selección de sala y la fila de `game` para serializar cambios de esa mesa. La pertenencia, capacidad, anfitrión, versión, fase, carta y plazo se validan dentro de la transacción. Los temporizadores usan el mismo bloqueo de partida.

Los cambios de cartas y turno, la versión, el recibo en `processed_operation` y el evento de `outbox` se guardan en un solo commit. Fallar al insertar el evento revierte también las cartas y el reparto. Un timeout usa el identificador estable `timeout:<ronda>:<turno>` y se registra como actor de sistema en nombre del jugador.

El recibo de un comando exitoso se recupera antes de volver a validar una fase o versión que pudo haber cambiado. Se limita al actor original y no contiene cartas. Reutilizar el ID con otro contenido se rechaza. Para un comando nuevo se vuelve a comprobar pertenencia vigente y permisos. Esto permite recuperar una confirmación perdida incluso después de pasar el turno o salir de una sala.

El cliente mantiene una sola acción pendiente, deshabilita otras acciones y conserva el comando original cuando falta la confirmación. **Reintentar la misma acción** envía el mismo ID y contenido. Al reconectar, vuelve a consultar su sala e intenta recuperar cualquier acción pendiente. Una recarga completa pierde esa cola en memoria, pero recupera el estado confirmado desde PostgreSQL.

## Sincronización y privacidad

| Evento         | Contrato                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `game:command` | Unión discriminada: `room:create`, `room:join`, `room:leave`, `room:start`, `turn:draw`, `turn:discard`, `turn:pass` |
| `room:current` | Solicita la sala actual de la identidad autenticada, sin admitir un jugador arbitrario                               |
| `game:changed` | Aviso posterior al commit: `{eventId,gameId,version}`                                                                |

Las respuestas usan `{ok:true,value}` o `{ok:false,code,message}`. El recibo de un comando contiene únicamente ID de operación, partida y versión. Zod rechaza propiedades adicionales.

El despachador envía un aviso sin cartas a las conexiones autenticadas de participantes de la partida. Ese aviso provoca una solicitud puntual de instantánea por WebSocket. No se realizan consultas periódicas de estado desde la web. El cliente deduplica avisos y evita aplicar versiones anteriores de la misma partida o respuestas superadas por una consulta posterior.

La instantánea se construye en una transacción de lectura `REPEATABLE READ`: entrega mano propia, nombres, asientos, cantidad de cartas ajenas, turno, reloj, cantidad del mazo y carta superior del descarte. No entrega manos rivales, orden del mazo, hashes ni tokens. El `requestId` de lectura no cambia el juego.

Una caída después del commit deja el aviso pendiente en outbox. Si falla la publicación, se conserva y se reintenta tras un segundo; si falla después de enviar y antes de marcarlo, puede llegar duplicado. `published_at` significa publicación, no recepción por todos. Reconectar siempre recupera una instantánea, aunque los avisos se hayan publicado sin clientes conectados.

Se mantiene **una instancia de backend**. Los bloqueos SQL protegen el estado, pero varias instancias requerirían coordinar las conexiones y la publicación. No se añadió Redis ni un broker.

## Cambios de esquema y organización

La tercera migración añade `game.last_action`, un índice de pertenencia por jugador y unicidad de `(actor_id, operation_id)` para comandos de jugador. Sigue habiendo 16 tablas de aplicación; se reutilizan las posiciones, rondas, operaciones y outbox del esquema existente.

| Archivo o módulo                    | Responsabilidad                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/contracts`                | Entradas validadas y tipos de sala, cartas, recibos y avisos                                   |
| `game/domain.ts`                    | Reparto, mezcla, robo, descarte, avance y conservación de cartas; sin acceso a infraestructura |
| `game/service.ts`                   | Casos de uso, autorización de negocio, transacciones e idempotencia                            |
| `game/store.ts`                     | Carga y guardado de posiciones; proyección privada                                             |
| `game/worker.ts`                    | Vencimientos y despacho de outbox; cierre ordenado                                             |
| `realtime/game-handlers.ts`         | Validación de sesión por solicitud y adaptación a Socket.IO                                    |
| `GameHub.tsx`, Redux y `session.ts` | Sala, mesa, selección de cartas, reloj y recuperación de confirmaciones                        |

## Verificación y límites

Las pruebas de dominio e integración cubren reparto con 2–6 jugadores, cientos de turnos y reciclado, límites temporales 29.999/30.000 ms, las tres fases de vencimiento, carreras entre jugadores/temporizadores, privacidad, idempotencia, rollback, publicación fallida y recuperación con una instancia nueva del servicio sobre la misma base.

Playwright verifica escritorio y móvil emulado: cuenta e invitado en una misma mesa, modalidades, ingreso por código, sala llena, transferencia de anfitrión, robo/descarte/pase, recarga, confirmación perdida y desconexión del jugador. El escenario de escritorio espera los 30 segundos reales con el worker activo; el de móvil adelanta únicamente el vencimiento de su base de pruebas. No existe un endpoint público para modificar el reloj.

No se han implementado todavía cierres por combinaciones/pintas/toque, evaluación de sobrantes, puntos, eliminación, siguiente ronda ni resultado final. Tampoco se cancela una partida activa desde la interfaz; la identidad vuelve a esa mesa mientras siga activa. Esta fase prueba el ciclo de turnos común a ambas modalidades, no partidas completas con ganador. Safari real, carga de 60 conexiones y ensayo de despliegue siguen pendientes.
