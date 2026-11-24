# Entrega del PMV — 18 de noviembre de 2026

El producto completa el ciclo de ambas modalidades del Entregable 2, con cuenta/invitado y turnos de 30 segundos acordados en este chat. La evidencia original de esta entrega corresponde al ensayo local y Docker del 18 de noviembre. El usuario confirmó después el funcionamiento en Vercel y Railway.

## Actualización del 24 de noviembre de 2026

Se incorporaron música discreta, tic-tac creciente durante los últimos siete segundos propios, silencio persistente, sidebar fijo en escritorio y menú modal en móvil, orden por palo/rango y arrastre con ratón/dedo/teclado. El orden se conserva durante la ronda y al recargar. Una carta nueva o recuperada del descarte se añade al final sin mover las demás. El tablero es gris fuera del turno propio, el código solo aparece en la espera y el descarte tiene pila visual y visor de consulta con fondo desenfocado.

El descarte manual avanza el turno en dos segundos sin requerir **Terminar turno**. Se puede declarar cierre/toque antes de descartar, con validación atómica. Tres vencimientos propios consecutivos hacen perder solo la ronda conforme a ADR-10; el contador persiste en PostgreSQL, se reinicia con un descarte manual o un nuevo reparto, y el anfitrión inactivo cede el control. Cuentas pueden recuperar su asiento desde otro dispositivo; invitados necesitan su sesión original. Ningún tercero ocupa un asiento de una partida iniciada.

Validación de esta actualización:

- Formato, tipos, arquitectura y compilación aprobados; 69 pruebas de lógica e integración aprobadas.
- Se ejecutaron los 30 escenarios de navegador en escritorio y móvil. Después de ajustar la espera del menú en la prueba de ingreso y ampliar la regresión de cartas que vuelven del descarte, los cuatro escenarios afectados se repitieron y aprobaron. Incluyen ratón, gesto táctil mediante CDP, teclado, cuatro turnos con orden estable, recarga, visor de solo lectura, audio real de Web Audio instrumentado y recuperación de cuenta en un contexto sin cookies compartidas. La emulación móvil no sustituye una prueba en un teléfono físico.
- Piloto local actualizado: 10 salas, 60 conexiones, 720 comandos y 4.320/4.320 avisos, sin errores ni duplicados. p95 de confirmación: 110,303 ms; p95 de commit a destinatario: 347,931 ms. [Resultado registrado](evidence/load-results-2026-11-24.json). No representa latencia por Internet.

Los cambios están preparados en el repositorio local. Su publicación requiere backend, quinta migración y frontend, en ese orden; ver la guía de despliegue. No se ejecutó esta actualización sobre la base de Railway durante las pruebas.

## Demostración

1. Abrir `http://127.0.0.1:5173` para desarrollo o `http://localhost:3100` para la versión compilada en Docker. Usar estos nombres distintos mantiene separadas sus sesiones.
2. Entrar con una cuenta. Abrir otro perfil/incógnito y entrar como invitado. Las pestañas normales comparten identidad.
3. Crear sala, elegir Clásica o Apuntado, compartir código, unirse y repartir. Se admiten 2–6 jugadores.
4. Robar del mazo o con **Robar del descarte**, seleccionar carta y descartar. El turno pasa automáticamente dos segundos después. Para cerrar o tocar, elegir la intención antes del descarte. Una declaración inválida explica el motivo y conserva las once cartas para corregirla.
5. Dejar vencer un turno: el servidor completa las acciones pendientes con descarte aleatorio, sin tocar ni cerrar.
6. Cerrar una ronda válida. El acta muestra las manos, combinaciones, sobrantes y, en Apuntado, anterior/cambio/total.
7. En Apuntado, repartir otra ronda y consultar las actas anteriores. Los eliminados observan sin recibir cartas. Clásica termina en su primer cierre válido.
8. Recargar o desconectarse/reconectarse: se recupera la misma partida. Al terminar, cada jugador vuelve al inicio independientemente.

Para una demostración automática sin esperar manos aleatorias, ejecutar `npm run test:e2e`; los repartos conocidos se inyectan únicamente en esquemas de pruebas. El producto no expone un modo de trampa ni endpoints para cambiar cartas.

## Evidencia ejecutada

| Comprobación                                 | Resultado                                                                                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formato, TypeScript y compilación            | Aprobados con `npm run check`.                                                                                                                                                    |
| Reglas, PostgreSQL, identidad y arquitectura | 61 pruebas aprobadas.                                                                                                                                                             |
| Navegador                                    | 24 escenarios de escritorio/móvil emulado; incluye seis contextos aislados, ambos cierres completos, historial, reconexión y 30 segundos reales.                                  |
| Arquitectura                                 | Grafo completo sin ciclos ni dependencias prohibidas; complejidad máxima 9 en 107 funciones medidas del dominio, reglas y coordinador. Controles negativos detectan infracciones. |
| Instalación limpia Linux                     | `npm ci` y compilación dentro de Node 24.22.3 en Docker.                                                                                                                          |
| Migraciones                                  | Base vacía, repetición y actualización desde fase 2 con recuperación del primer turno.                                                                                            |
| Reinicio                                     | Contenedor conserva identidad, cartas, versión y plazo; recupera un turno vencido una sola vez.                                                                                   |
| Restauración                                 | `pg_dump`/`pg_restore` en otra base; se comparan rondas, puntos, cartas, operaciones y evidencias.                                                                                |
| Dependencias de producción                   | `npm audit --omit=dev`: cero vulnerabilidades reportadas.                                                                                                                         |

El reporte HTML de Playwright queda en `playwright-report/index.html`. Las mediciones reproducibles están en `docs/evidence`; los respaldos privados permanecen en `.local/backups`, excluidos del repositorio y del paquete.

## Piloto de carga local

Diez salas de seis jugadores, 60 WebSockets autenticados y 1.080 comandos legales durante 60,3 segundos. Se recibieron **6.480 de 6.480** avisos esperados, sin errores ni duplicados. Se hicieron 7.560 consultas de vista autorizada; también se probaron reconexión, timeout y cierre de cada modalidad.

| Medida                            | p95        | p99        | Criterio p95 |
| --------------------------------- | ---------- | ---------- | ------------ |
| Comando → confirmación            | 47,931 ms  | 69,904 ms  | ≤500 ms      |
| Commit observado → recepción      | 274,552 ms | 295,593 ms | ≤500 ms      |
| Consulta de instantánea           | 48,190 ms  | 76,054 ms  | Informativo  |
| Evaluación de mano                | 0,103 ms   | 0,138 ms   | ≤50 ms       |
| Liquidación pura de dos jugadores | 0,232 ms   | 0,370 ms   | Informativo  |

Node 24.22.3, PostgreSQL 18, Windows, Intel i9-13900H; RTT local p95 1,255 ms. Servidor y clientes del piloto comparten reloj monotónico. Se toma el instante inmediatamente después de que `COMMIT` responde; no se mide por separado el pequeño sesgo de planificación anterior a esa observación. Estas cifras no acreditan Internet, dispositivos físicos, múltiples instancias ni cargas mayores. La preparación de las 60 identidades usa el servicio de autenticación fuera de la medición; los comandos medidos atraviesan Socket.IO y sus límites reales.

Reproducir: `npm run test:load`, después de preparar PostgreSQL y `TEST_DATABASE_URL`. La salida completa, incluidas muestras, queda en `.local/load-results.json`. No ejecutar carga sobre una base con usuarios reales.

## Trazabilidad

| Requisitos del E1 concretados por E2              | Implementación / prueba                                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RF-01–04: salas, perfiles, inicio, reparto        | `game/service.ts`, `domain.ts`; integración de salas, seis jugadores y eliminación.                                                                                                                                                              |
| RF-05–07: privacidad, recuperación, autoridad     | `store.ts`, handlers autenticados, `session.ts`; intrusos, reconexión, versiones y manos separadas.                                                                                                                                              |
| RF-08–11: robo, descarte, decisión, reciclado     | Dominio puro y plazo persistido; 104 cartas, cientos de turnos y las tres fases de timeout. Con ≤6 manos de 10/11 cartas siempre quedan cartas fuera de las manos: el agotamiento total después de reciclar es inalcanzable en un estado válido. |
| RF-12–17: grupos, escaleras, cierres, explicación | `game/rules`; pruebas de límites, coberturas disjuntas y mínimo sobrante.                                                                                                                                                                        |
| RF-18–23: liquidación, eliminación y acta         | `settlement-store.ts`, estrategias y `RoundResults.tsx`; rollback, idempotencia, históricos y final.                                                                                                                                             |
| RF-24–27: WebSockets y confirmaciones             | Outbox transaccional y vistas autorizadas; pérdida de ack, envío fallido, recepción de todos los clientes y ausencia de polling.                                                                                                                 |
| Acceso dual y 30 segundos del chat                | Identidad/sesiones, worker de turnos y pruebas de cuenta/invitado/reloj.                                                                                                                                                                         |
| Gobernanza E2                                     | Catálogo versionado, perfiles SQL inmutables, controles de arquitectura con casos negativos y decisiones del producto documentadas.                                                                                                              |

## Límites de esta entrega

- La URL pública, TLS del proveedor, CI remoto, dominios reales y prueba por Internet no se han ejecutado por falta de alojamiento configurado. Los archivos y pasos están en `docs/deployment.md`.
- Móvil se verifica con Chromium emulado. No se ha probado Safari/iPhone físico ni seis equipos físicos diferentes.
- Un backend, sin coordinación entre réplicas. El anfitrión inicia las siguientes rondas, incluso si quedó eliminado; debe conservar o recuperar su identidad. No hay transferencia automática por desconexión ni cancelación automática por abandono.
- Los invitados se recuperan en el navegador que conserva su sesión, no por nombre en otro dispositivo. Correo de recuperación, OAuth, chat, rankings y torneos quedan fuera del alcance acordado.
- El historial de actas se consulta dentro de la partida; no se añadió un archivo de partidas de la cuenta en el inicio.
- La auditoría de herramientas de desarrollo conserva cinco avisos altos derivados de una vulnerabilidad de `picomatch` sin corrección publicada al revisarla. No están en las dependencias de ejecución de la imagen final. Ver README y reauditar antes de publicar.

Los entregables originales y el repositorio académico permanecen sin cambios. Los scripts de empaquetado generan un manifiesto SHA-256 del código para identificar esta entrega, sin incluir `.env`, sesiones, respaldos ni dependencias instaladas.
