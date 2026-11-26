import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const TURN_SECONDS = 30 as const;
export const TIMEOUT_LIMIT = 3 as const;
export const DISCARD_PAUSE_MS = 2000 as const;
const displayName = z
  .string()
  .trim()
  .min(2, 'Escribe al menos 2 caracteres.')
  .max(60, 'Usa hasta 60 caracteres.')
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    'El nombre contiene caracteres no permitidos.',
  );
const email = z
  .string()
  .trim()
  .pipe(z.email('Escribe un correo válido.').max(254))
  .transform((value) => value.toLowerCase());
export const guestSchema = z.strictObject({ displayName });
export const registerSchema = z.strictObject({
  displayName,
  email,
  password: z.string().min(12, 'Usa al menos 12 caracteres.').max(128),
});
export const loginSchema = z.strictObject({ email, password: z.string().min(1).max(128) });
export const socketAuthSchema = z.strictObject({
  token: z.string().min(1).max(4096),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export const pingSchema = z.strictObject({ requestId: z.uuid() });
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type GuestInput = z.infer<typeof guestSchema>;
export interface PlayerIdentity {
  id: string;
  displayName: string;
  kind: 'account' | 'guest';
}
export interface SessionResponse {
  accessToken: string;
  expiresAt: string;
  player: PlayerIdentity;
  account: { email: string } | null;
}
export interface ApiError {
  error: { code: string; message: string; fields?: Record<string, string[]> };
}
export interface SessionReady {
  protocolVersion: 1;
  player: PlayerIdentity;
  serverTime: string;
}
export type PingResult =
  { ok: true; requestId: string; serverTime: string } | { ok: false; code: string };
export interface ServerToClientEvents {
  'session:ready': (value: SessionReady) => void;
  'session:expired': () => void;
  'session:revoked': () => void;
  'game:changed': (value: GameChanged) => void;
}
export interface ClientToServerEvents {
  'session:ping': (value: { requestId: string }, ack: (result: PingResult) => void) => void;
  'room:current': (
    value: { requestId: string },
    ack: (result: GameReply<RoomSnapshot | null>) => void,
  ) => void;
  'game:command': (value: GameCommand, ack: (result: GameReply<CommandReceipt>) => void) => void;
  'round:report': (
    value: RoundReportRequest,
    ack: (result: GameReply<RoundReport>) => void,
  ) => void;
}

const operation = { operationId: z.uuid() };
const versioned = {
  ...operation,
  gameId: z.uuid(),
  expectedVersion: z.number().int().nonnegative(),
};
const turn = {
  ...versioned,
  roundNo: z.number().int().positive(),
  turnNo: z.number().int().positive(),
};
export const createRoomSchema = z.strictObject({
  type: z.literal('room:create'),
  ...operation,
  name: z
    .string()
    .trim()
    .min(2, 'Escribe un nombre de al menos 2 caracteres.')
    .max(80)
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      'El nombre contiene caracteres no permitidos.',
    ),
  mode: z.enum(['classic', 'apuntado']),
  capacity: z.number().int().min(2).max(6),
});
export const joinRoomSchema = z.strictObject({
  type: z.literal('room:join'),
  ...operation,
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-HJ-NP-Z2-9]{8}$/, 'Escribe el código de 8 caracteres.'),
});
export const gameCommandSchema = z.discriminatedUnion('type', [
  createRoomSchema,
  joinRoomSchema,
  z.strictObject({ type: z.literal('room:leave'), ...versioned }),
  z.strictObject({ type: z.literal('game:surrender'), ...versioned }),
  z.strictObject({ type: z.literal('room:start'), ...versioned }),
  z.strictObject({ type: z.literal('turn:draw'), ...turn, source: z.enum(['stock', 'discard']) }),
  z.strictObject({
    type: z.literal('turn:discard'),
    ...turn,
    cardNo: z.number().int().min(1).max(104),
    closure: z.enum(['combinaciones', 'pintas', 'toque']).optional(),
  }),
  z.strictObject({ type: z.literal('turn:pass'), ...turn }),
  z.strictObject({
    type: z.literal('round:close'),
    ...turn,
    closure: z.enum(['combinaciones', 'pintas', 'toque']),
  }),
  z.strictObject({ type: z.literal('round:next'), ...versioned }),
]);
export const roundReportSchema = z.strictObject({
  requestId: z.uuid(),
  gameId: z.uuid(),
  roundNo: z.number().int().positive(),
});
export type RoundReportRequest = z.infer<typeof roundReportSchema>;
export type Closure = 'combinaciones' | 'pintas' | 'toque';
export type RoundClosure = Closure | 'inactivity' | 'abandonment';
export interface CardGroup {
  kind: 'group' | 'run' | 'suit';
  cards: PlayingCard[];
}
export interface RoundSummary {
  number: number;
  actorId: string;
  closure: RoundClosure;
  roundWinnerId: string | null;
  winnerId: string | null;
  next: 'home' | 'next-round';
  closedAt: string;
}
export interface RoundReport extends RoundSummary {
  profileId: string;
  players: {
    id: string;
    displayName: string;
    groups: CardGroup[];
    leftovers: PlayingCard[];
    penalty: number;
    explanation:
      | 'classic-close'
      | 'combinations'
      | 'suit'
      | 'touch'
      | 'minimum-penalty'
      | 'inactivity'
      | 'withdrawal'
      | 'last-in-round';
    roundForfeited: boolean;
    withdrawn: boolean;
    before: number | null;
    delta: number | null;
    after: number | null;
    eliminated: boolean;
  }[];
}
export type GameCommand = z.infer<typeof gameCommandSchema>;
export type GameMode = 'classic' | 'apuntado';
export type TurnPhase = 'draw' | 'discard' | 'decision';
export interface PlayingCard {
  cardNo: number;
  deck: 1 | 2;
  suit: 'C' | 'D' | 'H' | 'S';
  rank: number;
}
export interface RoomPlayer {
  id: string;
  displayName: string;
  seat: number;
  cardCount: number;
  score: number | null;
  eliminated: boolean;
  withdrawn: boolean;
  roundForfeited: boolean;
  consecutiveTimeouts: number;
}
export interface LastAction {
  type: GameCommand['type'] | 'turn:timeout' | 'round:forfeit';
  playerId: string;
  automatic: boolean;
  at: string;
}
export interface RoomSnapshot {
  id: string;
  name: string;
  code: string;
  mode: GameMode;
  capacity: number;
  hostId: string;
  status: 'waiting' | 'active' | 'paused' | 'between-rounds' | 'finished';
  version: number;
  players: RoomPlayer[];
  hand: PlayingCard[];
  turnSeconds: number;
  serverTime: string;
  lastAction: LastAction | null;
  history: RoundSummary[];
  result: RoundReport | null;
  outcome: { winnerId: string | null; reason: 'round' | 'abandonment' } | null;
  round: null | {
    number: number;
    turnNo: number;
    phase: TurnPhase;
    turnPlayerId: string;
    startedAt: string;
    deadlineAt: string;
    stockCount: number;
    discardTop: PlayingCard | null;
    discardPile: PlayingCard[];
  };
}
export interface CommandReceipt {
  operationId: string;
  gameId: string;
  version: number;
}
export interface GameChanged {
  eventId: string;
  gameId: string;
  version: number;
}
export type GameReply<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
