import { ZodError } from 'zod';
import { pingSchema, type GameReply } from '@apuntado/contracts';
import type { AuthService } from '../auth/service.js';
import type { GameService } from '../game/service.js';
import { AppError } from '../errors.js';
import type { AuthenticatedSocket } from './types.js';

export function registerGameHandlers(
  socket: AuthenticatedSocket,
  auth: AuthService,
  games: GameService,
) {
  let windowStart = Date.now(),
    count = 0;
  async function handle<T>(
    work: (playerId: string) => Promise<T>,
    ack: (reply: GameReply<T>) => void,
  ) {
    if (typeof ack !== 'function') return;
    if (Date.now() - windowStart >= 10000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > 40) {
      ack({
        ok: false,
        code: 'RATE_LIMITED',
        message: 'Espera un momento antes de enviar más solicitudes.',
      });
      return;
    }
    try {
      const identity = await auth.authenticate(socket.data.token);
      const value = await work(identity.player.id);
      ack({ ok: true, value });
    } catch (error) {
      ack({
        ok: false,
        code:
          error instanceof AppError
            ? error.code
            : error instanceof ZodError
              ? 'INVALID_COMMAND'
              : 'TEMPORARILY_UNAVAILABLE',
        message:
          error instanceof AppError
            ? error.message
            : error instanceof ZodError
              ? (error.issues[0]?.message ?? 'Revisa tu solicitud.')
              : 'No pudimos confirmar la acción. Puedes reintentarla.',
      });
      if (error instanceof AppError && error.code === 'SESSION_INVALID') {
        socket.emit('session:revoked');
        socket.disconnect(true);
      }
    }
  }
  socket.on(
    'room:current',
    (input, ack) =>
      void handle(async (playerId) => {
        pingSchema.parse(input);
        return games.current(playerId);
      }, ack),
  );
  socket.on(
    'game:command',
    (input, ack) => void handle((playerId) => games.execute(playerId, input), ack),
  );
  socket.on(
    'round:report',
    (input, ack) => void handle((playerId) => games.report(playerId, input), ack),
  );
}
