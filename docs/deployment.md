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

El backend y PostgreSQL están en línea en Railway. El backend público es `https://apuntadoserver-production.up.railway.app`; falta publicar el frontend en Vercel y verificar el juego con sus dominios reales. El `vercel.json` de la raíz ya está preparado para ese backend.

Railway retiró Config as Code para servicios nuevos. `deploy/railway.json` se conserva como referencia legacy, pero no configura este servicio. Los siguientes ajustes deben guardarse en el panel; una futura automatización debe usar Infrastructure as Code. Consultar la [nota oficial de retirada de Config as Code](https://docs.railway.com/config-as-code).

1. Crear PostgreSQL 18 y un servicio de backend en Railway, en la misma región/red privada. Mantener una sola réplica y desactivar Serverless/App Sleeping. Usar Root Directory `/` y el Dockerfile de la raíz. Dejar vacíos Custom Build Command y Custom Start Command para usar la compilación y el arranque definidos en Docker. Revisar Watch Paths: también deben disparar despliegues los cambios de paquetes compartidos, migraciones y configuración. Si Railway propone un servicio para `@apuntado/web`, descartar su creación: el frontend se publicará en Vercel.
2. Antes de pulsar Deploy, subir a GitHub la imagen que incluye el migrador y configurar las variables del backend. En Settings → Deploy → Add pre-deploy step, guardar Pre-deploy Command `node scripts/migrate.mjs`. Configurar también Healthcheck Path `/api/ready`. El comando se ejecuta en un contenedor previo, con acceso a la red privada y a `DATABASE_URL`; si falla, Railway detiene ese despliegue. La imagen final incluye los archivos de migración y `node-pg-migrate` como dependencia de producción. La tarea conserva las migraciones ya aplicadas; no crear tablas a mano. Para un servicio llamado `Postgres`, usar `DATABASE_URL=${{Postgres.DATABASE_URL}}` en las variables del backend. No ejecutar las migraciones durante el build. La etapa Docker `migrate` se conserva para el ensayo local con Compose.
3. Configurar backend: `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT` proporcionado por Railway, `DATABASE_URL`, `JWT_SECRET` aleatorio de al menos 48 caracteres, `ALLOWED_ORIGINS=https://frontend.example`, `SERVE_WEB=false`. Si aún no existe el frontend, usar temporalmente `ALLOWED_ORIGINS=https://pendiente.invalid`; permite arrancar y verificar `/api/ready`, pero no admite conexiones desde una web real. Reemplazarlo por el origen HTTPS exacto de Vercel antes de probar el juego. Usar `TRUST_PROXY=1` solo si hay exactamente un proxy confiable y no se puede acceder directamente al servidor. Validar esta condición con la topología real.
4. Obtener un origen HTTPS del backend. Preparar Vercel desde la raíz del monorepo:

```text
node scripts/configure-hosting.mjs https://backend.example https://frontend.example
```

El comando genera `vercel.json`, sin desplegar ni guardar secretos. Usar Node 24 en Vercel y definir `VITE_SOCKET_URL=https://backend.example` como variable de compilación. Esta URL es pública, no una credencial.

5. Vercel sirve la web y reescribe `/api/*` hacia Railway. Las cookies se reciben y envían al origen de la web; Socket.IO conecta directamente al backend por WSS, usando su token en memoria. Así se mantiene HTTP de identidad en el mismo origen y se evita depender de cookies de terceros. La configuración debe ensayarse con los dominios reales, encabezados reenviados y bloqueo de cookies de terceros antes de anunciar la URL.
6. Verificar `/api/ready`, registro/invitado, dos navegadores, un cierre por modalidad, reconexión, renovación de sesión, ausencia de polling y recuperación tras reinicio. Ejecutar el piloto remoto; los tiempos locales no garantizan tiempos por Internet.

### Primer despliegue del frontend en Vercel

Subir primero los commits locales a GitHub. En Vercel → Add New → Project, importar `AlzateJJ/apuntado-game` y elegir la raíz del repositorio (`./`). La configuración de la raíz compila los contratos compartidos y después el frontend.

| Ajuste                                    | Valor                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| Framework Preset                          | Other, correspondiente a `framework: null` en `vercel.json`              |
| Root Directory                            | Raíz del repositorio (`./`)                                              |
| Node.js Version                           | 24.x                                                                     |
| Install Command                           | `npm ci`                                                                 |
| Build Command                             | `npm run build -w @apuntado/contracts && npm run build -w @apuntado/web` |
| Output Directory                          | `apps/web/dist`                                                          |
| Variable de compilación `VITE_SOCKET_URL` | `https://apuntadoserver-production.up.railway.app`                       |

`vercel.json` define los comandos, el directorio de salida y las reescrituras. Agregar `VITE_SOCKET_URL` al entorno Production antes del primer Deploy. Si se modifica después, volver a desplegar: Vite incorpora esta variable durante la compilación.

Una vez Vercel asigne el dominio estable de producción, reemplazar `ALLOWED_ORIGINS=https://pendiente.invalid` en las variables del backend de Railway por ese origen HTTPS exacto, sin ruta ni barra final, y aplicar el despliegue de Railway. Hasta entonces el backend rechazará el acceso desde el frontend. Verificar `/api/ready` desde el dominio de Vercel, entrar como invitado, comprobar la conexión en tiempo real y recargar para verificar la sesión. La web usa `/api/*` en su propio origen mediante reescrituras, mientras Socket.IO conecta directamente a Railway.

La configuración de Vercel se basa en [reescrituras externas oficiales](https://vercel.com/docs/routing/rewrites); la imagen sigue el soporte de [Dockerfiles de Railway](https://docs.railway.com/builds/dockerfiles). Las migraciones siguen el [comando previo al despliegue de Railway](https://docs.railway.com/deployments/pre-deploy-command). La selección de URL y transporte utiliza las [opciones oficiales de Socket.IO](https://socket.io/docs/v4/client-options/). Documentación de despliegue revisada el 24 de noviembre de 2026.

Verificación local del 24 de noviembre de 2026: se compiló la imagen `runtime`, se ejecutaron sus cuatro migraciones contra PostgreSQL 18 vacío y se repitió el comando sin duplicarlas. Con `NODE_ENV=production`, `SERVE_WEB=false` y el origen provisional, `/api/ready` respondió HTTP 200. Se comprobó que la imagen incluye el migrador y excluye TypeScript y Vite. Los contenedores y la base de esta prueba fueron temporales; no se ejecutó contra Railway.

Verificación en Railway del 24 de noviembre de 2026: el primer arranque falló con `relation "auth_session" does not exist` porque no había Pre-deploy Command. Se guardaron en el panel la migración previa y `/api/ready`, y se dejaron vacíos los comandos personalizados de build/start. El despliegue `775bf7ca-8327-48a9-9703-2c58c3f81ae5`, basado en el commit `23a950b`, terminó con `Deployment successful`; backend y PostgreSQL aparecen `Online`. El servicio aún figura como `Unexposed service`, por lo que esto no verifica acceso público ni partidas desde Internet. Antes del siguiente cambio de código compartido, ampliar los Watch Paths actuales, limitados a `/apps/server/**`.

## Actualización de interfaz e inactividad del 24 de noviembre

El usuario confirmó que el primer despliegue completo ya funciona. Esta actualización añade `1795500000000-round-inactivity.cjs` (quinta migración), contratos nuevos y lógica de servidor, además del frontend. Publicar primero el backend con `node scripts/migrate.mjs` en Pre-deploy Command y verificar `/api/ready`, que ahora comprueba las columnas de inactividad. Publicar después el frontend. No basta con desplegar solo Vercel. Los Watch Paths de Railway deben incluir `apps/server/**`, `packages/contracts/**`, `database/**`, `scripts/**`, `Dockerfile`, `package.json` y `package-lock.json`.

La migración conserva partidas, posiciones y resultados existentes; inicializa en cero las rachas de inactividad. Para probar sin tocar producción, la suite crea esquemas temporales en la base `_test`. El orden manual y el silencio se guardan en cada navegador. No se agregaron dependencias, variables ni permisos del proveedor.

## Operación

- `GET /api/health`: proceso vivo. `GET /api/ready`: conexión y esquema necesarios disponibles.
- SIGTERM/SIGINT detienen el worker y las conexiones, con plazo de cierre de diez segundos.
- Un reinicio reconstruye estado desde PostgreSQL y completa una vez los turnos vencidos; no reinicia los relojes ni simula turnos perdidos durante la caída.
- El publicador reintenta outbox. `published_at` significa enviado, no recibido por cada navegador; reconectar siempre recupera la vista vigente.
- No escalar a varias réplicas sin coordinar publicación y conexiones. No hay Redis ni broker en este PMV.
- Las migraciones posteriores a fase 2 conservan evidencias; para un downgrade se requiere restauración ensayada, no borrar tablas con usuarios conectados.
