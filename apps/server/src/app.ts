import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import pino from 'pino';
import { ZodError } from 'zod';
import type { Pool } from 'pg';
import { AuthService } from './auth/service.js';
import { authRouter } from './auth/routes.js';
import { createRealtimeServer } from './realtime/server.js';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { GameService, type GameOptions } from './game/service.js';
import { gameWorker } from './game/worker.js';

export function createApplication(
  config: Config,
  pool: Pool,
  options: GameOptions & { backgroundWork?: boolean } = {},
) {
  const app = express();
  const httpServer = createServer(app);
  const logger = pino({ level: config.LOG_LEVEL });
  const auth = new AuthService(pool, config);
  const games = new GameService(pool, options);
  const io = createRealtimeServer(httpServer, auth, config, games);
  const worker = gameWorker(games, () => logger.error('Game background task failed; will retry'));
  if (options.backgroundWork !== false) httpServer.once('listening', () => worker.start());
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY === '1' ? 1 : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'upgrade-insecure-requests': config.production ? [] : null },
      },
    }),
  );
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !!origin && config.origins.includes(origin)),
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Apuntado-Client'],
      methods: ['GET', 'POST', 'OPTIONS'],
    }),
  );
  app.use(express.json({ limit: '8kb' }));
  app.use(cookieParser());
  app.use('/api', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/api/ready', async (_request, response) => {
    try {
      await pool.query(
        'SELECT s.session_id,g.last_action,r.initial_player_id,rp.timeout_streak,rp.forfeited,rr.round_winner_id FROM auth_session s CROSS JOIN game g CROSS JOIN round r CROSS JOIN round_participation rp CROSS JOIN round_result rr LIMIT 0',
      );
      response.json({ status: 'ready' });
    } catch {
      response.status(503).json({ status: 'unavailable' });
    }
  });
  app.use('/api/auth', authRouter(auth, config));
  app.use('/api', (_request, response) =>
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada.' } }),
  );
  const webPath = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (config.SERVE_WEB === 'true' && existsSync(`${webPath}/index.html`)) {
    app.use(express.static(webPath, { index: false }));
    app.get('/{*path}', (_request, response) => response.sendFile(`${webPath}/index.html`));
  }
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ZodError) {
      const fields: Record<string, string[]> = {};
      for (const issue of error.issues)
        (fields[String(issue.path[0] ?? 'form')] ??= []).push(issue.message);
      response.status(400).json({
        error: { code: 'VALIDATION_FAILED', message: 'Revisa los datos del formulario.', fields },
      });
      return;
    }
    if (error instanceof AppError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    const status = (error as { status?: number })?.status;
    if (status === 400 || status === 413) {
      response
        .status(status)
        .json({ error: { code: 'INVALID_BODY', message: 'La solicitud no es válida.' } });
      return;
    }
    const incident = randomUUID();
    logger.error(
      { incident, errorType: error instanceof Error ? error.name : 'Unknown' },
      'Request failed',
    );
    response.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'No pudimos completar la solicitud. Intenta de nuevo.',
        incident,
      },
    });
  };
  app.use(errors);
  return {
    app,
    httpServer,
    io,
    auth,
    games,
    logger,
    close: async () => {
      await worker.stop();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}
