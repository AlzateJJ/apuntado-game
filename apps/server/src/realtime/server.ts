import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { ZodError } from 'zod';
import {
  socketAuthSchema,
  pingSchema,
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@apuntado/contracts';
import { AuthService, type Authenticated } from '../auth/service.js';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import type { GameService } from '../game/service.js';
import { registerGameHandlers } from './game-handlers.js';

export function createRealtimeServer(
  httpServer: HttpServer,
  auth: AuthService,
  config: Config,
  games: GameService,
) {
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    { identity: Authenticated; token: string }
  >(httpServer, {
    transports: ['websocket'],
    maxHttpBufferSize: 8192,
    serveClient: false,
    allowRequest: (request, done) =>
      done(null, !!request.headers.origin && config.origins.includes(request.headers.origin)),
  });
  auth.onRevoke = (sessionId) => {
    io.to(`session:${sessionId}`).emit('session:revoked');
    io.in(`session:${sessionId}`).disconnectSockets(true);
  };
  games.publish = async (event, recipients) => {
    if (recipients.length)
      io.to(recipients.map((id) => `player:${id}`)).emit('game:changed', event);
  };
  io.use(async (socket, next) => {
    try {
      const input = socketAuthSchema.parse(socket.handshake.auth);
      socket.data.identity = await auth.authenticate(input.token);
      socket.data.token = input.token;
      next();
    } catch (error) {
      const result = new Error('No se pudo validar la sesión.') as Error & {
        data: { code: string };
      };
      result.data = {
        code:
          error instanceof ZodError
            ? 'PROTOCOL_INVALID'
            : error instanceof AppError
              ? error.code
              : 'TEMPORARILY_UNAVAILABLE',
      };
      next(result);
    }
  });
  io.on('connection', (socket) => {
    const identity = socket.data.identity;
    void socket.join(`session:${identity.sessionId}`);
    void socket.join(`player:${identity.player.id}`);
    registerGameHandlers(socket, auth, games);
    socket.emit('session:ready', {
      protocolVersion: PROTOCOL_VERSION,
      player: identity.player,
      serverTime: new Date().toISOString(),
    });
    const timeout = setTimeout(
      () => {
        socket.emit('session:expired');
        socket.disconnect(true);
      },
      Math.max(0, identity.expiresAt - Date.now()),
    );
    timeout.unref();
    socket.on('disconnect', () => clearTimeout(timeout));
    let windowStart = Date.now();
    let messages = 0;
    socket.on('session:ping', async (input, ack) => {
      if (typeof ack !== 'function') return;
      if (Date.now() - windowStart >= 10000) {
        windowStart = Date.now();
        messages = 0;
      }
      if (++messages > 20) {
        ack({ ok: false, code: 'RATE_LIMITED' });
        return;
      }
      const parsed = pingSchema.safeParse(input);
      if (!parsed.success) {
        ack({ ok: false, code: 'INVALID_COMMAND' });
        return;
      }
      try {
        await auth.authenticate(socket.data.token);
        ack({ ok: true, requestId: parsed.data.requestId, serverTime: new Date().toISOString() });
      } catch (error) {
        ack({
          ok: false,
          code: error instanceof AppError ? error.code : 'TEMPORARILY_UNAVAILABLE',
        });
        if (error instanceof AppError) {
          socket.emit('session:revoked');
          socket.disconnect(true);
        }
      }
    });
  });
  return io;
}
