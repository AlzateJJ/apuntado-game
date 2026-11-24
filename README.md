# Apuntado

PMV funcional del Entregable 2: cuentas e invitados, salas por código, Clásica y Apuntado, reparto privado, turnos de **30 segundos**, descarte automático, cierres, actas, puntos, eliminaciones, siguientes rondas y resultado final. Incluye pruebas de navegador, piloto de 60 conexiones y despliegue local reproducible con Docker.

La [guía de entrega](docs/delivery.md) reúne cómo demostrarlo, la trazabilidad y los límites verificados. La [guía de despliegue](docs/deployment.md) explica Docker, respaldos y la publicación en Vercel/Railway. El repositorio ya está conectado a GitHub y el backend se está preparando en Railway; el despliegue público todavía debe verificarse.

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
6. Cerrar sesión: se revocan la credencial y todas las conexiones de esa sesión. Un invitado que sale necesita crear otro acceso.
7. Crear una sala, elegir modalidad/capacidad y compartir su código. El anfitrión inicia con al menos dos jugadores.
8. Robar del mazo o del descarte, seleccionar una carta propia, descartarla y terminar el turno.
9. Dejar vencer los 30 segundos: el servidor completa robo/descarte/pase según la fase, sin hacer un segundo descarte si ya ocurrió.
10. Después del descarte, cerrar por combinaciones; en Apuntado también puedes cerrar por pintas o tocar. Un cierre inválido conserva la mano y el plazo.
11. Consultar las manos y la liquidación de cada ronda. En Apuntado, el anfitrión reparte la siguiente hasta que haya ganador; los eliminados siguen como espectadores.
12. Recuperar el resultado al recargar y pulsar **Volver al inicio** para jugar otra partida.

**Para probar dos jugadores en un equipo**, usa un navegador normal y una ventana de incógnito, o perfiles distintos. Las pestañas normales comparten identidad. La guía de [fase 2](docs/phase-2.md) detalla el recorrido, los contratos y las reglas operativas.

La salida de sala se permite antes de empezar y después del resultado final. Antes del inicio transfiere el anfitrión si corresponde. Durante una partida activa, desconectarse conserva el asiento y los turnos siguen automáticamente. No se asigna un ganador por desconexión ni se cancela por abandono automáticamente.

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
