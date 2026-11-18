import { Pool } from 'pg';
import { readConfig } from './config.js';
import { createApplication } from './app.js';

const config = readConfig();
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const application = createApplication(config, pool);
pool.on('error', () => application.logger.error('Database pool error'));
await pool.query('SELECT session_id FROM auth_session LIMIT 0');
await pool.query('SELECT last_action FROM game LIMIT 0');
await pool.query('SELECT initial_player_id FROM round LIMIT 0');
await new Promise<void>((resolve, reject) => {
  application.httpServer.once('error', reject);
  application.httpServer.listen(config.PORT, config.HOST, resolve);
});
application.logger.info({ host: config.HOST, port: config.PORT }, 'Apuntado iniciado');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    await application.close();
    await pool.end();
    clearTimeout(deadline);
    process.exit(0);
  });
