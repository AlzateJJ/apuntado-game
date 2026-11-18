import { io, type Socket } from 'socket.io-client';
import {
  PROTOCOL_VERSION,
  type ApiError,
  type SessionResponse,
  type ServerToClientEvents,
  type ClientToServerEvents,
  type GameCommand,
  type RoundReport,
} from '@apuntado/contracts';
import { actions, gameActions, store } from './store';

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}
async function post<T>(path: string, body: unknown = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/auth/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Apuntado-Client': '1' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiFailure(
      0,
      'OFFLINE',
      'No pudimos conectar. Revisa tu conexión e intenta de nuevo.',
    );
  }
  if (!response.ok) {
    const value = (await response.json().catch(() => null)) as ApiError | null;
    throw new ApiFailure(
      response.status,
      value?.error.code ?? 'UNAVAILABLE',
      value?.error.message ?? 'El servicio no está disponible.',
      value?.error.fields,
    );
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}
const channel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('apuntado-session') : null;
let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let pendingRefresh: Promise<void> | null = null;
let generation = 0;
let readSequence = 0;
const seenEvents = new Set<string>();
const locked = async <T>(run: () => Promise<T>): Promise<T> =>
  navigator.locks ? await navigator.locks.request('apuntado-auth', run) : await run();

function stopConnection() {
  clearTimeout(refreshTimer);
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}
function signedOut(message?: string) {
  generation++;
  stopConnection();
  readSequence++;
  seenEvents.clear();
  store.dispatch(actions.signedOut(message));
}
function connect(session: SessionResponse) {
  socket?.removeAllListeners();
  socket?.disconnect();
  store.dispatch(actions.connectionChanged('connecting'));
  const current: Socket<ServerToClientEvents, ClientToServerEvents> = io(
    import.meta.env.VITE_SOCKET_URL || window.location.origin,
    {
      autoConnect: false,
      transports: ['websocket'],
      auth: { token: session.accessToken, protocolVersion: PROTOCOL_VERSION },
      reconnectionDelayMax: 5000,
    },
  );
  socket = current;
  current.on('session:ready', (ready) => {
    if (ready.player.id !== session.player.id) {
      signedOut('No pudimos validar tu identidad. Vuelve a entrar.');
      return;
    }
    current
      .timeout(5000)
      .emit('session:ping', { requestId: crypto.randomUUID() }, (error, result) => {
        if (socket !== current) return;
        store.dispatch(actions.connectionChanged(!error && result.ok ? 'online' : 'offline'));
        if (!error && result.ok) {
          void syncGame();
          if (store.getState().game.pending) void retryGameCommand();
        }
      });
  });
  current.on('game:changed', (event) => {
    if (socket !== current || seenEvents.has(event.eventId)) return;
    seenEvents.add(event.eventId);
    if (seenEvents.size > 200) seenEvents.delete(seenEvents.values().next().value!);
    const room = store.getState().game.room;
    if (room?.id === event.gameId && room.version >= event.version) return;
    void syncGame();
  });
  current.on('disconnect', () => {
    if (socket === current) store.dispatch(actions.connectionChanged('offline'));
  });
  current.on('connect_error', () => {
    if (socket === current) store.dispatch(actions.connectionChanged('offline'));
  });
  current.on('session:expired', () => {
    if (socket === current) void refreshSession();
  });
  current.on('session:revoked', () => {
    if (socket === current) signedOut('La sesión terminó. Puedes volver a entrar.');
  });
  current.connect();
}
function applySession(session: SessionResponse) {
  clearTimeout(refreshTimer);
  store.dispatch(actions.signedIn(session));
  connect(session);
  refreshTimer = setTimeout(
    () => void refreshSession(),
    Math.max(1000, Date.parse(session.expiresAt) - Date.now() - 30000),
  );
}
export function refreshSession(): Promise<void> {
  if (pendingRefresh) return pendingRefresh;
  const expected = generation;
  pendingRefresh = locked(async () => {
    if (expected !== generation) return;
    try {
      let session: SessionResponse;
      try {
        session = await post<SessionResponse>('refresh');
      } catch (error) {
        if (!(error instanceof ApiFailure) || error.code !== 'REFRESH_CONFLICT') throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
        session = await post<SessionResponse>('refresh');
      }
      if (expected === generation) applySession(session);
    } catch (error) {
      if (expected !== generation) return;
      if (error instanceof ApiFailure && error.status === 401) {
        signedOut();
        return;
      }
      const message = error instanceof Error ? error.message : 'No se pudo recuperar tu sesión.';
      if (!store.getState().auth.session) store.dispatch(actions.signedOut(message));
      else store.dispatch(actions.noticeChanged(message));
      refreshTimer = setTimeout(() => void refreshSession(), 10000);
    }
  }).finally(() => {
    pendingRefresh = null;
  });
  return pendingRefresh;
}
export async function enter(mode: 'login' | 'register' | 'guest', values: unknown) {
  const expected = ++generation;
  clearTimeout(refreshTimer);
  await locked(async () => {
    const session = await post<SessionResponse>(mode, values);
    if (expected === generation) {
      applySession(session);
      channel?.postMessage('changed');
    }
  });
}
export async function logout() {
  await locked(async () => {
    await post('logout');
    signedOut();
    channel?.postMessage('logout');
  });
}
channel?.addEventListener('message', (event) => {
  if (event.data === 'logout') signedOut();
  if (event.data === 'changed') {
    const prior = pendingRefresh;
    signedOut();
    void (prior ?? Promise.resolve()).then(refreshSession);
  }
});
export function reconnect() {
  void refreshSession();
}
window.addEventListener('online', reconnect);
document.addEventListener('visibilitychange', () => {
  const session = store.getState().auth.session;
  if (
    document.visibilityState === 'visible' &&
    session &&
    Date.parse(session.expiresAt) <= Date.now() + 30000
  )
    reconnect();
  else if (document.visibilityState === 'visible' && session) void syncGame();
});

export async function syncGame() {
  const current = socket;
  if (!current?.connected) return;
  const sequence = ++readSequence;
  const started = performance.now();
  try {
    const reply = await current
      .timeout(5000)
      .emitWithAck('room:current', { requestId: crypto.randomUUID() });
    if (socket !== current || sequence !== readSequence) return;
    if (reply.ok)
      store.dispatch(
        gameActions.synchronized({
          room: reply.value,
          receivedAt: performance.now(),
          roundTripMs: performance.now() - started,
        }),
      );
    else store.dispatch(gameActions.readFailed(reply.message));
  } catch {
    if (socket === current && sequence === readSequence)
      store.dispatch(
        gameActions.readFailed('No pudimos actualizar la mesa. Reintenta la conexión.'),
      );
  }
}
export async function fetchRoundReport(gameId: string, roundNo: number): Promise<RoundReport> {
  const current = socket;
  if (!current?.connected) throw new Error('Recupera la conexión para consultar el acta.');
  const reply = await current
    .timeout(5000)
    .emitWithAck('round:report', { requestId: crypto.randomUUID(), gameId, roundNo });
  if (socket !== current) throw new Error('La conexión cambió. Vuelve a consultar el acta.');
  if (!reply.ok) throw new Error(reply.message);
  return reply.value;
}
export async function sendGameCommand(command: GameCommand) {
  if (store.getState().game.pending) return;
  if (!socket?.connected || store.getState().auth.connection !== 'online') {
    store.dispatch(gameActions.readFailed('Espera a recuperar la conexión antes de jugar.'));
    return;
  }
  store.dispatch(gameActions.commandStarted(command));
  await retryGameCommand();
}
export async function retryGameCommand() {
  const current = socket;
  const command = store.getState().game.pending;
  if (!command || !current?.connected) return;
  store.dispatch(gameActions.commandStarted(command));
  try {
    const reply = await current.timeout(5000).emitWithAck('game:command', command);
    if (socket !== current || store.getState().game.pending?.operationId !== command.operationId)
      return;
    if (reply.ok) store.dispatch(gameActions.commandConfirmed());
    else
      store.dispatch(
        gameActions.commandFailed({
          message: reply.message,
          uncertain: reply.code === 'TEMPORARILY_UNAVAILABLE' || reply.code === 'RATE_LIMITED',
        }),
      );
  } catch {
    if (socket === current && store.getState().game.pending?.operationId === command.operationId)
      store.dispatch(
        gameActions.commandFailed({
          message:
            'No llegó la confirmación. Reintenta la misma acción para comprobar su resultado.',
          uncertain: true,
        }),
      );
  }
  if (socket === current) await syncGame();
}
