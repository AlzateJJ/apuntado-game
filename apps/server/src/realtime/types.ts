import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@apuntado/contracts';
import type { Authenticated } from '../auth/service.js';
export type AuthenticatedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  { identity: Authenticated; token: string }
>;
