import { test as base, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { createApplication } from '../../apps/server/src/app.js';
import { readConfig } from '../../apps/server/src/config.js';

type Harness = { url: string; application: ReturnType<typeof createApplication>; pool: Pool };
export const test = base.extend<{}, { harness: Harness }>({
  harness: [
    async ({}, use) => {
      const databaseUrl = process.env.TEST_DATABASE_URL;
      if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
        throw new Error('E2E requiere TEST_DATABASE_URL con nombre terminado en _test.');
      const schema = `e2e_${randomUUID().replaceAll('-', '')}`;
      await runner({
        databaseUrl,
        schema,
        createSchema: true,
        dir: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
        migrationsTable: 'schema_migrations',
        direction: 'up',
        log: () => {},
      });
      const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
      const config = readConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        JWT_SECRET: 'e2e-test-secret-not-for-production-'.repeat(3),
        ALLOWED_ORIGINS: 'http://127.0.0.1:3102',
        LOG_LEVEL: 'silent',
        SERVE_WEB: 'true',
      });
      const application = createApplication(config, pool);
      await new Promise<void>((resolve) => application.httpServer.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(application.httpServer.address() as { port: number }).port}`;
      config.origins.push(url);
      try {
        await use({ url, application, pool });
      } finally {
        await application.close();
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await pool.end();
      }
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ harness }, use) => use(harness.url),
});

export { expect };
