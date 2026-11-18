import { Router, type Response, type RequestHandler } from 'express';
import { guestSchema, loginSchema, registerSchema } from '@apuntado/contracts';
import { AuthService, type IssuedSession } from './service.js';
import type { Config } from '../config.js';
import { AppError, sessionError } from '../errors.js';

export function authRouter(auth: AuthService, config: Config) {
  const router = Router();
  const origins: RequestHandler = (request, _response, next) => {
    if (
      !config.origins.includes(request.get('origin') ?? '') ||
      request.get('X-Apuntado-Client') !== '1'
    )
      throw new AppError(403, 'ORIGIN_REJECTED', 'Esta solicitud no proviene de la aplicación.');
    if (!request.is('application/json'))
      throw new AppError(415, 'JSON_REQUIRED', 'Se requiere contenido JSON.');
    next();
  };
  const limits = new Map<string, { count: number; until: number }>();
  const rateLimit: RequestHandler = (request, response, next) => {
    const now = Date.now();
    for (const [key, entry] of limits) if (entry.until <= now) limits.delete(key);
    const key = request.ip ?? 'unknown';
    const entry = limits.get(key) ?? { count: 0, until: now + 15 * 60000 };
    if (++entry.count > 40 || (!limits.has(key) && limits.size >= 10000)) {
      response.setHeader('Retry-After', Math.max(1, Math.ceil((entry.until - now) / 1000)));
      throw new AppError(429, 'RATE_LIMITED', 'Has hecho muchos intentos. Espera unos minutos.');
    }
    limits.set(key, entry);
    next();
  };
  const cookieName = config.production ? '__Secure-apuntado_refresh' : 'apuntado_refresh';
  const cookieOptions = {
    httpOnly: true,
    secure: config.production,
    sameSite: 'lax' as const,
    path: '/api/auth',
  };
  const sendSession = (response: Response, session: IssuedSession, status = 200) => {
    response.cookie(cookieName, session.refreshToken, {
      ...cookieOptions,
      expires: session.sessionExpiresAt,
    });
    response.status(status).json(session.body);
  };
  router.post('/guest', origins, rateLimit, async (request, response) => {
    const input = guestSchema.parse(request.body);
    const session = await auth.guest(input);
    await auth.logout(request.cookies[cookieName]);
    sendSession(response, session, 201);
  });
  router.post('/register', origins, rateLimit, async (request, response) => {
    const input = registerSchema.parse(request.body);
    const session = await auth.register(input);
    await auth.logout(request.cookies[cookieName]);
    sendSession(response, session, 201);
  });
  router.post('/login', origins, rateLimit, async (request, response) => {
    const input = loginSchema.parse(request.body);
    const session = await auth.login(input);
    await auth.logout(request.cookies[cookieName]);
    sendSession(response, session);
  });
  router.post('/refresh', origins, async (request, response) => {
    sendSession(response, await auth.refresh(request.cookies[cookieName]));
  });
  router.post('/logout', origins, async (request, response) => {
    await auth.logout(request.cookies[cookieName]);
    response.clearCookie(cookieName, cookieOptions).status(204).end();
  });
  router.get('/me', async (request, response) => {
    const header = request.get('authorization');
    if (!header?.startsWith('Bearer ')) throw sessionError();
    const identity = await auth.authenticate(header.slice(7));
    response.json({ player: identity.player });
  });

  return router;
}
