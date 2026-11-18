import './check-node.mjs';
import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export async function migrate(databaseUrl, schema = 'public') {
  if (!databaseUrl) throw new Error('DATABASE_URL es obligatorio.');
  return runner({
    databaseUrl,
    dir: fileURLToPath(new URL('../database/migrations', import.meta.url)),
    direction: 'up',
    migrationsTable: 'schema_migrations',
    schema,
    createSchema: true,
    log: (message) => console.log(message),
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await migrate(process.env.DATABASE_URL);
}
