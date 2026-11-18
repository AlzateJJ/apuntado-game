import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(48),
  ALLOWED_ORIGINS: z.string().min(1),
  ACCESS_TOKEN_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  SESSION_DAYS: z.coerce.number().int().min(1).max(30).default(14),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
  SERVE_WEB: z.enum(['true', 'false']).default('true'),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = envSchema.parse(env);
  if (value.JWT_SECRET.startsWith('REPLACE_'))
    throw new Error('Genera JWT_SECRET antes de iniciar.');
  const origins = value.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim());
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
      throw new Error('ALLOWED_ORIGINS debe contener orígenes exactos.');
    if (value.NODE_ENV === 'production' && url.protocol !== 'https:')
      throw new Error('Producción requiere HTTPS.');
  }
  return { ...value, origins, production: value.NODE_ENV === 'production' };
}
export type Config = ReturnType<typeof readConfig>;
