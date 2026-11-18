# Ejecutar, respaldar y publicar

## Ensayo local en Docker

Desde la raíz del producto, con Docker Desktop activo:

```powershell
.\scripts\npm.ps1 run setup
.\scripts\npm.ps1 run preview:up
```

Abrir `http://localhost:3100`. Se usa `localhost` para separar sus cookies de la vista de desarrollo en `127.0.0.1:5173`. Este proyecto Compose tiene su propio PostgreSQL, volumen y migraciones; no altera la base de desarrollo de la fase 1. La imagen ejecuta JavaScript compilado, como usuario sin privilegios, sin Vite ni dependencias de desarrollo. El contenedor de migraciones se ejecuta una vez antes de iniciar la aplicación.

`preview:down` detiene el ensayo y conserva el volumen. No añadir `-v` si se quieren conservar las partidas. El ensayo usa HTTP exclusivamente local y `NODE_ENV=development` para sus cookies; la publicación real debe usar HTTPS y `NODE_ENV=production`.

## Respaldo, restauración y reinicio verificados

```powershell
$runtimeNode = (Get-Content .local/node-path.txt -Raw).Trim()
& $runtimeNode scripts/operations-drill.mjs
```

En otro equipo con Node 24: `node scripts/operations-drill.mjs`.

El ensayo crea dos invitados en la aplicación de Docker, reparte, reinicia el servidor y verifica identidad, mano, versión y vencimiento. Completa un timeout y un cierre con un reparto conocido en la base de ensayo. Detiene esa aplicación, genera un `pg_dump` binario, restaura en una base temporal nueva y compara rondas, cartas, operaciones, eventos, puntos y evidencias. Elimina únicamente la base temporal creada por el propio ensayo y vuelve a iniciar el servidor. Escribe resultados y respaldo en `.local`; no exponer esos respaldos porque incluyen sesiones e identidades.

Para respaldar un servidor real se debe usar `pg_dump` con un rol y conexión autorizados, guardar el archivo fuera del servidor con acceso restringido, y restaurar primero en una base nueva. Nunca usar `--clean` contra la base activa como ensayo. La prueba local no configura respaldos periódicos de un proveedor remoto.

## Publicación prevista: Vercel + Railway

No se crearon cuentas, proyectos pagos ni dominios. La configuración queda preparada para el momento en que estén disponibles.

1. Crear PostgreSQL 18 y un servicio de backend en Railway, en la misma región/red privada. Mantener una sola réplica. Usar el Dockerfile de la raíz y la configuración `deploy/railway.json`.
2. Ejecutar las migraciones como tarea de liberación antes de habilitar esa versión: `docker build --target migrate -t apuntado-migrate .`, y ejecutar esa imagen con `DATABASE_URL` del entorno. Dentro del proveedor se necesita un trabajo con acceso a la red privada; no publicar la base únicamente para facilitar migraciones. Alternativamente, un job de CI autorizado puede ejecutar `npm ci` y `npm run db:migrate` con conexión segura al destino. La imagen de runtime no contiene la herramienta de migración.
3. Configurar backend: `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT` proporcionado por Railway, `DATABASE_URL`, `JWT_SECRET` aleatorio de al menos 48 caracteres, `ALLOWED_ORIGINS=https://frontend.example`, `SERVE_WEB=false`. Usar `TRUST_PROXY=1` solo si hay exactamente un proxy confiable y no se puede acceder directamente al servidor. Validar esta condición con la topología real.
4. Obtener un origen HTTPS del backend. Preparar Vercel desde la raíz del monorepo:

```text
node scripts/configure-hosting.mjs https://backend.example https://frontend.example
```

El comando genera `vercel.json`, sin desplegar ni guardar secretos. Usar Node 24 en Vercel y definir `VITE_SOCKET_URL=https://backend.example` como variable de compilación. Esta URL es pública, no una credencial.

5. Vercel sirve la web y reescribe `/api/*` hacia Railway. Las cookies se reciben y envían al origen de la web; Socket.IO conecta directamente al backend por WSS, usando su token en memoria. Así se mantiene HTTP de identidad en el mismo origen y se evita depender de cookies de terceros. La configuración debe ensayarse con los dominios reales, encabezados reenviados y bloqueo de cookies de terceros antes de anunciar la URL.
6. Verificar `/api/ready`, registro/invitado, dos navegadores, un cierre por modalidad, reconexión, renovación de sesión, ausencia de polling y recuperación tras reinicio. Ejecutar el piloto remoto; los tiempos locales no garantizan tiempos por Internet.

La configuración de Vercel se basa en [reescrituras externas oficiales](https://vercel.com/docs/routing/rewrites); la imagen sigue el soporte de [Dockerfiles de Railway](https://docs.railway.com/builds/dockerfiles). La selección de URL y transporte utiliza las [opciones oficiales de Socket.IO](https://socket.io/docs/v4/client-options/). Documentación consultada el 18 de noviembre de 2026.

## Operación

- `GET /api/health`: proceso vivo. `GET /api/ready`: conexión y esquema necesarios disponibles.
- SIGTERM/SIGINT detienen el worker y las conexiones, con plazo de cierre de diez segundos.
- Un reinicio reconstruye estado desde PostgreSQL y completa una vez los turnos vencidos; no reinicia los relojes ni simula turnos perdidos durante la caída.
- El publicador reintenta outbox. `published_at` significa enviado, no recibido por cada navegador; reconectar siempre recupera la vista vigente.
- No escalar a varias réplicas sin coordinar publicación y conexiones. No hay Redis ni broker en este PMV.
- Las migraciones posteriores a fase 2 conservan evidencias; para un downgrade se requiere restauración ensayada, no borrar tablas con usuarios conectados.
