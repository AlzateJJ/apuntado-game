# Fase 3: cierres, actas y fin de partida

Se implementan las reglas del Entregable 2, página 3, y del núcleo académico `design/src/domain` y `variants`. No se modifican los entregables originales ni se incorporan cierres adicionales del prototipo antiguo.

## Reglas

| Modalidad o acción        | Resultado                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Clásica                   | Solo 4-3-3; una ronda, ganador del cierre, sin movimientos de puntaje.                                             |
| Combinaciones en Apuntado | 4-3-3 o 5-5: +10 al declarante.                                                                                    |
| Pintas                    | Diez cartas del mismo palo: +25; no se acumula con +10.                                                            |
| Toque                     | Una o dos sobrantes, suma ≤5 y total posterior >−101. Sin premio; se conserva exactamente el descuento autorizado. |
| Oponentes                 | Se descuenta el menor valor de sobrantes entre particiones válidas. Cero sobrantes produce cambio 0.               |
| Eliminación               | Total ≤−101. El participante conserva consulta pública, sin manos ni turnos nuevos.                                |
| Victoria                  | Total ≥+51 o único activo. Se guarda el ganador y se permite volver al inicio.                                     |

Se reconocen grupos desde tres cartas del mismo rango, incluidas copias de ambos mazos. Las escaleras comparten palo: A-2-3 y Q-K-A son válidas; K-A-2 y rangos repetidos no. A/J/Q/K valen 10. Las nueve pintas permiten organizar nueve cartas para un toque; ocho pintas no constituyen una excepción. Una mano con patrón completo o diez pintas no puede tocar.

El evaluador enumera conjuntos de cartas físicas, busca coberturas disjuntas y conserva una explicación reproducible. Ordena por identidad física antes de evaluar; reordenar visualmente no altera la respuesta. El cierre por patrón usa exactamente sus tamaños; el descuento puede aprovechar cualquier conjunto de combinaciones válidas, conforme al núcleo académico.

## Comandos y lectura

- `round:close`: operación, partida, versión, ronda, turno y `combinaciones | pintas | toque`.
- `round:next`: operación, partida y versión; solo el anfitrión, entre rondas.
- `round:report`: lectura autenticada de una ronda cerrada. Se rechaza a intrusos y a antiguos visitantes que nunca participaron en una ronda.
- `room:leave`: también permite cerrar la vista del resultado final. En ese caso no depende de que otro jugador haya vuelto al inicio primero; el resultado permanece intacto.

El cierre exige fase de decisión, identidad del turno y plazo vigente. Un rechazo conserva cartas, versión, puntajes y vencimiento, y no revela manos ajenas. El vencimiento solo completa robo/descarte/pase; nunca cierra ni toca.

## Persistencia y siguientes rondas

En una sola transacción se guardan resultado, movimientos, evaluación, cada carta de la explicación, eliminación, estado de ronda/partida, versión, recibo idempotente y outbox. Si falla una escritura, se revierte todo. Los reintentos recuperan el mismo recibo incluso después de avanzar de ronda o volver al inicio.

El estado `between-rounds` permite leer el acta antes del nuevo reparto. El anfitrión puede repartir aunque esté eliminado: ese permiso administrativo no le devuelve cartas. El primer turno rota desde el primer jugador de la ronda anterior, por asientos, saltando eliminados. Se crean 104 posiciones nuevas; las posiciones y evaluaciones de rondas cerradas se conservan. Las 104 copias físicas de la partida se reutilizan.

La migración 4 añade `round.initial_player_id`, `round_result.closed_at` y `participation.eliminated_at_round`; no añade tablas. Para partidas de fase 2 infiere el jugador inicial desde el turno y el orden de asientos, sin reiniciar cartas ni reloj. Una prueba de actualización cubre huecos de asientos y vueltas completas.

La instantánea muestra el marcador solo en Apuntado. Durante una ronda entrega únicamente la mano propia. El acta pública contiene grupos, sobrantes, descuento, anterior/cambio/total y eliminación; puede recuperarse después de un reinicio. El historial conserva resúmenes y consulta cada acta a petición, evitando reenviar todas las manos históricas en cada jugada.

## Verificación

Pruebas de reglas: ases, copias físicas, patrones, pintas, toque 4/5/6, nueve/ocho pintas, autoeliminación, ±umbrales, coberturas superpuestas y descuento mínimo. PostgreSQL: permisos, versión, fase, plazo, reintentos/carreras, rollback real de puntos y actas, rotación, espectador eliminado, reinicio y fin de ambas modalidades.

Playwright completa Clásica y Apuntado en escritorio y móvil, consulta actas anteriores, recarga resultados y verifica retorno al inicio de todos. Las pruebas de cierre usan repartos conocidos únicamente en sus bases aisladas; no existe una ruta pública para elegir cartas o modificar el reloj.
