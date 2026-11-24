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

Consecuencia original: las desconexiones no reinician plazos. Un reinicio completa un turno vencido, sin simular una cadena de decisiones durante la caída. ADR-10 actualiza la transición posterior al descarte y define la pérdida de ronda por inactividad.

## ADR-09 — Liquidación explicativa e historial

Las reglas puras se registran por perfil inmutable. El coordinador mantiene la transacción y las estrategias determinan la liquidación. Las coberturas usan identidad física, no posición visual; se conserva la organización que permitió el toque. Se persisten acta, movimientos, explicación por carta y eliminación junto con el recibo y eventos.

Consecuencia: una nueva ronda crea posiciones nuevas y no reescribe la anterior. Un eliminado sigue siendo miembro espectador. Se mantiene una pausa explícita entre rondas, con siguiente reparto del anfitrión y rotación del jugador inicial. Clásica termina sin marcador acumulativo. El resultado final permanece consultable hasta que cada jugador vuelva al inicio.

## ADR-10 — Descarte ágil e inactividad por ronda

Actualización solicitada y confirmada por el usuario el 24 de noviembre de 2026. Se mantienen 30 segundos para robar y descartar. Un descarte manual sin cierre abre una transición persistida de dos segundos; el worker avanza una sola vez y empieza los 30 segundos completos del siguiente jugador. Esa transición no cuenta como turno automático por inactividad. `turn:pass` queda rechazado; el usuario no necesita pulsar un botón para continuar. Una intención opcional `closure` en `turn:discard` permite declarar cierre/toque y validar las diez cartas restantes en la misma transacción. Si falla, también se revierte el descarte. El comando de cierre previo sigue aceptado durante una fase de decisión válida.

Cada participación en una ronda tiene `timeout_streak` y `forfeited`. Solo un vencimiento en robo o descarte suma una falta; un descarte manual válido reinicia la racha. Al llegar a tres turnos propios consecutivos vencidos, el jugador pierde esa ronda, conserva sus diez cartas privadas y deja de recibir turnos. El estado y la penalización no dependen del socket y sobreviven al reinicio. Los demás continúan. Si queda uno, se liquida la ronda por `inactivity`: en Clásica gana la partida sin puntajes; en Apuntado los ausentes reciben el descuento mínimo habitual por sobrantes y el superviviente recibe cero, sin premio de cierre. Solo se elimina de la partida a quien llegue a −101 o menos. La siguiente ronda incluye a los no eliminados y reinicia las rachas. Si el anfitrión pierde la ronda por inactividad, el primer participante que sigue jugando recibe el control del siguiente reparto.

No existe reemplazo por desconexión: cuentas con la misma identidad recuperan su asiento en otro dispositivo; invitados necesitan su cookie vigente en el mismo navegador. Se oculta el código tras iniciar, pero la autorización se sigue imponiendo en el servidor.

## ADR-11 — Orden local, sonido y navegación

El orden de la mano se guarda por jugador/partida/ronda en `localStorage`, sin credenciales; al reconciliar una nueva vista solo se eliminan cartas ausentes y se agregan las nuevas al final. Arrastrar, ordenar por palo y ordenar por rango cambian la presentación, nunca la propiedad o evaluación de las cartas. El teclado usa Alt + flechas. El orden no se sincroniza entre dispositivos.

El sidebar toma como referencia la disposición del proyecto Medical Diagnosis, manteniendo el estilo de Apuntado. En móvil usa un diálogo modal nativo con foco contenido, cierre con Escape y devolución del foco. El historial y las reglas no desmontan la mesa ni reinician el reloj.

Web Audio genera una melodía original discreta y los avisos, sin librerías ni archivos externos. El contexto se desbloquea con una interacción; se pausa al silenciar u ocultar la pestaña. La preferencia de silencio persiste. El tic-tac solo corresponde al propietario del turno, de siete a un segundo, con volumen creciente acotado. El descarte se consulta mediante un diálogo de solo lectura: muestra las cartas presentes en esa pila, no un historial de cartas que ya fueron robadas o recicladas.
