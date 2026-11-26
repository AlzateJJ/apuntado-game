import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import type { RoomSnapshot } from '@apuntado/contracts';
import type { RootState } from './store';
import { retryGameCommand, sendGameCommand } from './session';

export function LeaveGame({ room }: { room: RoomSnapshot | null }) {
  const { connection } = useSelector((state: RootState) => state.auth);
  const { pending, retryRequired, error } = useSelector((state: RootState) => state.game);
  const [openedRoom, setOpenedRoom] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const open = !!room && openedRoom === room.id;
  const active = room && !['waiting', 'finished'].includes(room.status);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    element.showModal();
    document.body.classList.add('leave-game-open');
    return () => {
      element.close();
      document.body.classList.remove('leave-game-open');
    };
  }, [open]);
  const close = () => setOpenedRoom(null);
  const busy = !!pending && !retryRequired;
  if (!room || (!active && !open)) return null;
  return (
    <div className="leave-game-bar">
      {active && (
        <button
          className="leave-game-trigger"
          onClick={() => setOpenedRoom(room.id)}
          disabled={connection !== 'online' || (!!pending && pending.type !== 'game:surrender')}
        >
          Abandonar partida <span aria-hidden="true">↗</span>
        </button>
      )}
      <dialog
        ref={dialog}
        className="leave-game-dialog"
        aria-labelledby="leave-game-title"
        aria-describedby="leave-game-description"
        onClose={close}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !busy) close();
        }}
      >
        <div className="leave-game-content">
          <span className="eyebrow">TU LUGAR EN LA MESA</span>
          <h2 id="leave-game-title">¿Abandonar la partida?</h2>
          <p id="leave-game-description">
            {room.status === 'finished'
              ? 'La partida terminó. Volverás al inicio para elegir otra mesa.'
              : 'Te rendirás y saldrás de esta partida. Podrás crear o unirte a otra sala de inmediato, pero no volver a esta.'}
          </p>
          {active && (
            <p>
              Los demás continúan. Si queda un solo jugador, gana la partida. Si eres anfitrión,
              otro jugador tomará tu lugar.
            </p>
          )}
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          <div className="leave-game-actions">
            <button className="secondary-button" autoFocus onClick={close} disabled={busy}>
              Seguir en la partida
            </button>
            <button
              className="leave-game-confirm"
              disabled={connection !== 'online' || busy}
              onClick={() => {
                if (retryRequired) void retryGameCommand();
                else
                  void sendGameCommand({
                    type: 'game:surrender',
                    operationId: crypto.randomUUID(),
                    gameId: room.id,
                    expectedVersion: room.version,
                  });
              }}
            >
              {busy
                ? 'Confirmando…'
                : retryRequired
                  ? 'Reintentar salida'
                  : 'Abandonar y volver al inicio'}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
