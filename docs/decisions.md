# Decisiones del producto complementarias al Entregable 2

Fecha: 18 de noviembre de 2026. Estado: implementadas. Estos registros complementan ADR-01–05 del repositorio académico; no los reemplazan ni alteran su evidencia histórica.

## ADR-06 — Socket.IO y servidor autoritativo

Socket.IO 4, exclusivamente WebSocket, transporta intenciones y vistas autorizadas. La identidad proviene de la sesión, nunca del payload. Cada mutación usa versión y UUID de operación; el servidor bloquea la partida, decide, guarda y confirma. La outbox contiene avisos sin manos; después del commit cada participante consulta su propia vista. Reconectar reconstruye desde PostgreSQL. Se acepta entrega repetida de avisos y se deduplican; no se promete entrega exactamente una vez por la red.

Consecuencia: un proceso con worker de vencimientos y outbox basta para el PMV. Varias réplicas requieren coordinación adicional. Los percentiles del piloto incluyen espera real de outbox y recepción de los clientes, no solo respuesta al actor.

## ADR-07 — Cuenta e invitado sobre una identidad común

Una cuenta vincula correo normalizado y contraseña Argon2 a `player`. Un invitado también tiene `player`, sin cuenta. Las sesiones persisten en PostgreSQL mediante hashes de credenciales de renovación; la cookie es HttpOnly, SameSite=Lax y Secure en producción. El token corto solo vive en memoria. Las reglas no distinguen la capacidad de jugar según el método de acceso.

Consecuencia: recargar conserva la identidad, pero un invitado no recupera su lugar por repetir el nombre. Al desplegar web y backend separados se utiliza un proxy HTTP de identidad en el origen web y WSS directo al backend; la publicación con dominios reales todavía debe ensayarse.

## ADR-08 — Turnos persistentes de 30 segundos

El usuario fijó 30 segundos totales. Se guarda inicio y vencimiento en la ronda; dibujar el contador no consulta el servidor. El worker usa el mismo bloqueo que una acción manual. Al vencer: robar si faltaba, descartar aleatoriamente una carta de las once si faltaba y pasar. La recién robada puede salir. Si ya descartó, solo se pasa. No se declara cierre ni toque automáticamente.

Consecuencia: las desconexiones no reinician plazos ni eliminan jugadores. Un reinicio completa un turno vencido, sin simular una cadena de decisiones durante la caída. Una partida abandonada no inventa un ganador.

## ADR-09 — Liquidación explicativa e historial

Las reglas puras se registran por perfil inmutable. El coordinador mantiene la transacción y las estrategias determinan la liquidación. Las coberturas usan identidad física, no posición visual; se conserva la organización que permitió el toque. Se persisten acta, movimientos, explicación por carta y eliminación junto con el recibo y eventos.

Consecuencia: una nueva ronda crea posiciones nuevas y no reescribe la anterior. Un eliminado sigue siendo miembro espectador. Se mantiene una pausa explícita entre rondas, con siguiente reparto del anfitrión y rotación del jugador inicial. Clásica termina sin marcador acumulativo. El resultado final permanece consultable hasta que cada jugador vuelva al inicio.
