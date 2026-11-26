import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { SessionResponse, RoomSnapshot, GameCommand } from '@apuntado/contracts';

export type Connection = 'offline' | 'connecting' | 'online';
interface AuthState {
  status: 'checking' | 'anonymous' | 'authenticated';
  session: SessionResponse | null;
  connection: Connection;
  notice: string | null;
}
const initialState: AuthState = {
  status: 'checking',
  session: null,
  connection: 'offline',
  notice: null,
};
const auth = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    signedIn(state, action: PayloadAction<SessionResponse>) {
      state.session = action.payload;
      state.status = 'authenticated';
      state.notice = null;
    },
    signedOut(state, action: PayloadAction<string | undefined>) {
      state.session = null;
      state.status = 'anonymous';
      state.connection = 'offline';
      state.notice = action.payload ?? null;
    },
    connectionChanged(state, action: PayloadAction<Connection>) {
      state.connection = action.payload;
    },
    noticeChanged(state, action: PayloadAction<string | null>) {
      state.notice = action.payload;
    },
  },
});
export const actions = auth.actions;
interface GameState {
  room: RoomSnapshot | null;
  loaded: boolean;
  error: string | null;
  errorAction: 'dismiss' | 'sync' | 'retry' | null;
  pending: GameCommand | null;
  retryRequired: boolean;
  receivedAt: number;
  roundTripMs: number;
}
const emptyGame: GameState = {
  room: null,
  loaded: false,
  error: null,
  errorAction: null,
  pending: null,
  retryRequired: false,
  receivedAt: 0,
  roundTripMs: 0,
};
const game = createSlice({
  name: 'game',
  initialState: emptyGame,
  reducers: {
    synchronized(
      state,
      action: PayloadAction<{ room: RoomSnapshot | null; receivedAt: number; roundTripMs: number }>,
    ) {
      if (
        state.room &&
        action.payload.room?.id === state.room.id &&
        action.payload.room.version < state.room.version
      )
        return;
      state.room = action.payload.room;
      state.loaded = true;
      state.receivedAt = action.payload.receivedAt;
      state.roundTripMs = action.payload.roundTripMs;
      if (state.errorAction === 'sync') {
        state.error = null;
        state.errorAction = null;
      }
    },
    commandStarted(state, action: PayloadAction<GameCommand>) {
      state.pending = action.payload;
      state.retryRequired = false;
      state.error = null;
      state.errorAction = null;
    },
    commandConfirmed(state) {
      state.pending = null;
      state.retryRequired = false;
      state.error = null;
      state.errorAction = null;
    },
    commandFailed(
      state,
      action: PayloadAction<{ message: string; uncertain: boolean; code?: string }>,
    ) {
      state.error = action.payload.message;
      state.retryRequired = action.payload.uncertain;
      state.errorAction = action.payload.uncertain
        ? 'retry'
        : ['VERSION_CONFLICT', 'TURN_CHANGED', 'TURN_EXPIRED', 'TURN_ADVANCING'].includes(
              action.payload.code ?? '',
            )
          ? 'sync'
          : 'dismiss';
      if (!action.payload.uncertain) state.pending = null;
    },
    readFailed(state, action: PayloadAction<string>) {
      state.error = action.payload;
      state.errorAction = state.retryRequired ? 'retry' : 'sync';
    },
    noticeDismissed(state) {
      if (state.errorAction !== 'dismiss') return;
      state.error = null;
      state.errorAction = null;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(auth.actions.signedOut, () => emptyGame);
  },
});
export const gameActions = game.actions;
export const store = configureStore({ reducer: { auth: auth.reducer, game: game.reducer } });
export type RootState = ReturnType<typeof store.getState>;
