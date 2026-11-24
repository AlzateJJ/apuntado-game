# Apuntado

PMV funcional del Entregable 2: cuentas e invitados, salas por código, Clásica y Apuntado, reparto privado, turnos de **30 segundos**, descarte automático, cierres, actas, puntos, eliminaciones, siguientes rondas y resultado final. Incluye pruebas de navegador, piloto de 60 conexiones y despliegue local reproducible con Docker.

La [guía de entrega](docs/delivery.md) reúne cómo demostrarlo, la trazabilidad y los límites verificados. La [guía de despliegue](docs/deployment.md) explica Docker, respaldos y la publicación en Vercel/Railway. El usuario confirmó el funcionamiento del frontend en Vercel con el backend y PostgreSQL en Railway. Las mejoras de interfaz e inactividad del 24 de noviembre requieren actualizar ambos despliegues y aplicar la quinta migración.

## Ejecutar en este equipo

Abre una terminal en esta carpeta. Requiere Docker Desktop encendido. El Node del sistema es 20; el script auxiliar utiliza Node 24 sin cambiar la instalación global. La ruta local ya quedó configurada en `.local/node-path.txt`, archivo excluido de Git.

```powershell
.\scripts\npm.ps1 ci
.\scripts\npm.ps1 run setup
.\scripts\npm.ps1 run db:up
.\scripts\npm.ps1 run db:migrate
.\scripts\npm.ps1 run dev
```

Abre <http://127.0.0.1:5173>. Para detener web y servidor, usa Ctrl+C en esa terminal. PostgreSQL conserva los datos en un volumen de Docker; `docker compose stop` lo detiene sin borrarlos.

Si está activa la vista previa que inició Codex en segundo plano, puedes detenerla con `.\scripts\stop-preview.ps1` antes de ejecutar otra instancia de `dev`.

En un equipo con **Node 24 LTS + npm y Docker Compose**, los mismos comandos se ejecutan con `npm` en lugar de `.\scripts\npm.ps1`. El auxiliar de Windows también admite una ruta a Node 24 mediante `APUNTADO_NODE24`.

`setup` crea `.env` con una clave aleatoria y conserva el archivo si ya existe. Las credenciales incluidas en Compose son únicamente para desarrollo local. PostgreSQL escucha en `127.0.0.1:54329`: se eligió este puerto porque Windows reserva el 55432 en este equipo.

## Qué se puede probar

1. **Crear cuenta**: nombre, correo y contraseña de al menos 12 caracteres.
2. **Ingresar** con esa cuenta después de salir.
3. **Invitado**: entrar únicamente con un nombre. Dos invitados con el mismo nombre son identidades distintas.
4. Ver **Conexión activa** después de autenticar y confirmar la comunicación de ida y vuelta.
5. Recargar o abrir otra pestaña: se conserva la identidad mediante una cookie privada.
6. Abrir la flecha junto al usuario y elegir **Mi cuenta** o **Cerrar sesión**. En móvil, el avatar del header abre un panel inferior con las mismas opciones. Mi cuenta muestra nombre, correo (solo al propietario), tipo de acceso y preferencia de sonido. Cerrar sesión revoca la credencial y todas las conexiones de esa sesión; un invitado que sale necesita crear otro acceso.
7. Crear una sala, elegir modalidad y capacidad con los botones **2–6**, y compartir su código. El anfitrión inicia con al menos dos jugadores.
8. Pulsar el mazo o la carta superior del descarte para robar, seleccionar una carta y descartarla: el siguiente turno comienza automáticamente después de dos segundos. El botón **Ver cartas descartadas**, debajo de la pila, abre el visor de consulta incluso fuera de tu turno.
9. Dejar vencer los 30 segundos: el servidor completa robo/descarte/pase según la fase, sin hacer un segundo descarte si ya ocurrió.
10. Antes de descartar, elegir **Cerrar por combinaciones**; en Apuntado también puedes cerrar por pintas o tocar. La intención y el descarte se validan juntos; una declaración inválida conserva las once cartas y el plazo para corregirla.
11. Consultar las manos y la liquidación de cada ronda. En Apuntado, el anfitrión reparte la siguiente hasta que haya ganador; los eliminados siguen como espectadores.
12. Recuperar el resultado al recargar y pulsar **Volver al inicio** para jugar otra partida.
13. Ordenar por palo, de menor a mayor (A, 2…10, J, Q, K) o arrastrando cartas con ratón/dedo. Alt + flechas ofrece una alternativa de teclado. El orden se guarda por jugador, partida y ronda en este navegador, sobrevive a cambios de turno y recargas, y añade las cartas nuevas al final.
14. Abrir **Cómo jugar** o **Rondas anteriores** desde el sidebar fijo en escritorio y el menú de hamburguesa en móvil. Los datos de usuario están en la parte inferior del menú.
15. Escuchar la música tras la primera interacción, el tic-tac creciente de los últimos siete segundos propios y silenciarlos con el altavoz. La preferencia persiste. Una pestaña oculta deja de sonar.
16. Perder tres turnos propios consecutivos: se pierde solo la ronda. Un descarte manual válido reinicia el contador; la pausa normal de dos segundos no penaliza. Ver ADR-10 para el descuento y la continuidad del juego.

**Para probar dos jugadores en un equipo**, usa un navegador normal y una ventana de incógnito, o perfiles distintos. Las pestañas normales comparten identidad. La guía de [fase 2](docs/phase-2.md) detalla el recorrido, los contratos y las reglas operativas.

La salida de sala se permite antes de empezar y después del resultado final. Desconectarse conserva el asiento y el reloj; no admite sustitutos. Con una cuenta, iniciar sesión desde otro dispositivo recupera la misma partida. Tres turnos automáticos consecutivos hacen perder la ronda y se omite ese asiento hasta el siguiente reparto. Si queda uno, gana la ronda: en Clásica termina la partida; en Apuntado no recibe premio de cierre y los ausentes pierden los puntos de sus cartas sin combinación. Pueden volver en la siguiente ronda si no llegaron a −101. Si el anfitrión pierde la ronda por inactividad, el control pasa a otro jugador.

El JWT solo permanece en memoria. No hay tokens en `localStorage`, `sessionStorage` ni URLs. La renovación dura como máximo 14 días desde el inicio de la sesión; no se extiende indefinidamente. Una cuenta permite volver a entrar con sus credenciales. Un invitado no se recupera por nombre ni desde otro dispositivo.

## Organización

```text
apps/
  server/src/
    auth/                 Rutas HTTP, contraseñas, sesiones y persistencia de identidad
    realtime/             Transporte Socket.IO y autorización de conexiones
    game/                 Salas, dominio de cartas, transacciones, vistas y worker de turnos
    app.ts                Composición HTTP + Socket.IO
    config.ts             Configuración validada
    main.ts               Inicio y cierre del proceso
  web/src/                React, formularios, Redux y ciclo de sesión/conexión
packages/contracts/       Esquemas Zod y contratos compartidos
database/
  migrations/             Migraciones versionadas y transaccionales
  schema-baseline.sql     Esquema del Entregable 2
  schema-phase1.sql       Extensiones acordadas para el producto
scripts/                  Desarrollo, configuración y migraciones
tests/                    Integración con PostgreSQL + navegador
```

Es un **monolito modular**, con una aplicación web, un servidor y PostgreSQL. No se han creado microservicios independientes. El repositorio académico `../apuntado-arquitectura` y el proyecto antiguo se conservan como referencias. El motor del entregable se adaptó a evaluaciones explicativas y estrategias puras, con transacciones PostgreSQL y un catálogo por perfil inmutable.

## Verificaciones

```powershell
.\scripts\npm.ps1 run check
.\scripts\npm.ps1 run test:e2e
.\scripts\npm.ps1 run test:load
.\scripts\npm.ps1 audit --omit=dev
```

`check` revisa formato, tipos, integración y compilación. Las pruebas necesitan PostgreSQL y una `TEST_DATABASE_URL` cuyo nombre de base termine en `_test`; crean y eliminan únicamente sus propios esquemas. Compose crea `apuntado` y `apuntado_test` en el primer arranque de un volumen vacío. Nunca se ejecutan pruebas sobre la base de desarrollo.

Playwright utiliza Microsoft Edge instalado en Windows. En Linux, instala Chromium con `npx playwright install --with-deps chromium`. Cubre escritorio y viewport móvil; la emulación móvil no sustituye una prueba en Safari/iPhone real. El workflow de GitHub Actions queda preparado, pero no se ha ejecutado en un remoto.

Los informes de las fases anteriores se conservan como historial: [fase 1](docs/phase-1.md), [fase 2](docs/phase-2.md) y [fase 3](docs/phase-3.md). El estado final y sus mediciones están en [la guía de entrega](docs/delivery.md). Las pruebas de carga usan 10 salas y 60 conexiones reales sobre una base de pruebas aislada; no sustituyen un ensayo por Internet.

## Compilación y ejecución sin Vite

```powershell
.\scripts\npm.ps1 run build
.\scripts\npm.ps1 start
```

Abre <http://127.0.0.1:3001>. Express entrega también la web compilada: HTTP y WebSocket comparten origen y las sesiones no requieren cookies de terceros.

Para un futuro despliegue: `NODE_ENV=production`, orígenes HTTPS exactos, clave nueva, base privada y `HOST=0.0.0.0` si lo necesita el alojamiento. `TRUST_PROXY=1` solo corresponde a un despliegue con un único proxy confiable y sin acceso directo al servidor. El proxy debe admitir WebSockets. Se ejecuta `db:migrate` antes de iniciar; el servidor no altera el esquema automáticamente.

## Dependencias pendientes

`npm audit --omit=dev` no reportó vulnerabilidades. La auditoría completa reporta cinco entradas de severidad alta derivadas de una misma vulnerabilidad de `picomatch`, utilizada por Vite y sus herramientas. El [aviso GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) indica que todavía no existe una versión corregida. Se conserva el servidor de desarrollo ligado a loopback y no se aceptan patrones glob del usuario. La ejecución de producción sirve archivos compilados y no utiliza Vite. Revisar este aviso antes del despliegue; no aplicar `npm audit fix --force` sin evaluar los cambios de versión.

Las herramientas de migración usan `glob 14.0.6` y `minimatch 11.0.9` mediante overrides para evitar los avisos presentes en sus versiones transitivas originales. Las migraciones y la instalación quedan verificadas con el lockfile.
