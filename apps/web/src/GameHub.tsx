import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  createRoomSchema,
  joinRoomSchema,
  type GameCommand,
  type PlayingCard,
  type RoomSnapshot,
  type Closure,
} from '@apuntado/contracts';
import type { RootState } from './store';
import { sendGameCommand, retryGameCommand, syncGame } from './session';
import { RoundOutcome } from './RoundResults';
import { SoundButton, useTurnWarning } from './Sound';
import { SortableHand } from './SortableHand';
import { DiscardPile } from './DiscardPile';

const suits = {
  C: { symbol: '♣', name: 'tréboles' },
  D: { symbol: '♦', name: 'diamantes' },
  H: { symbol: '♥', name: 'corazones' },
  S: { symbol: '♠', name: 'picas' },
};
const discardIntents = [
  { value: '', label: 'Continuar al siguiente turno' },
  { value: 'combinaciones', label: 'Cerrar por combinaciones' },
  { value: 'pintas', label: 'Cerrar por pintas' },
  { value: 'toque', label: 'Tocar' },
] as const;
const rankName = (rank: number) => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' })[rank] ?? String(rank);
const cardName = (card: PlayingCard) =>
  `${rankName(card.rank)} de ${suits[card.suit].name}, copia ${card.deck}`;
function CardFace({ card }: { card: PlayingCard }) {
  return (
    <span
      className={`playing-card ${card.suit === 'D' || card.suit === 'H' ? 'red-suit' : ''}`}
      aria-hidden="true"
    >
      <b>
        {rankName(card.rank)}
        <small>{suits[card.suit].symbol}</small>
      </b>
      <span>{suits[card.suit].symbol}</span>
      <i>{card.deck}</i>
    </span>
  );
}
function RoomForms({ disabled }: { disabled: boolean }) {
  const [name, setName] = useState('Mesa entre amigos');
  const [mode, setMode] = useState<'classic' | 'apuntado'>('apuntado');
  const [capacity, setCapacity] = useState(6);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (input: unknown, kind: 'create' | 'join') => {
    const parsed = (kind === 'create' ? createRoomSchema : joinRoomSchema).safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisa los datos.');
      return;
    }
    setError(null);
    void sendGameCommand(parsed.data);
  };
  return (
    <section className="room-home">
      <div className="room-intro">
        <div className="eyebrow">LA BUENA COMPAÑÍA YA ESTÁ</div>
        <h1>Arma tu mesa.</h1>
        <p>Invita a tus amigos con un código y elijan su próxima mano.</p>
      </div>
      <div className="room-forms">
        <form
          className="room-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit(
              { type: 'room:create', operationId: crypto.randomUUID(), name, mode, capacity },
              'create',
            );
          }}
        >
          <span className="section-number">01</span>
          <h2>Crear una sala</h2>
          <p className="muted">
            Tú serás el anfitrión. Podrás empezar cuando haya al menos dos jugadores.
          </p>
          <div className="field">
            <label htmlFor="room-name">Nombre de la sala</label>
            <input
              id="room-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              disabled={disabled}
            />
          </div>
          <fieldset className="mode-options" disabled={disabled}>
            <legend>Modalidad</legend>
            <label className={mode === 'classic' ? 'chosen' : ''}>
              <input
                type="radio"
                name="mode"
                value="classic"
                checked={mode === 'classic'}
                onChange={() => setMode('classic')}
              />
              <b>Clásica</b>
              <span>Una ronda · sin puntaje</span>
            </label>
            <label className={mode === 'apuntado' ? 'chosen' : ''}>
              <input
                type="radio"
                name="mode"
                value="apuntado"
                checked={mode === 'apuntado'}
                onChange={() => setMode('apuntado')}
              />
              <b>Apuntado</b>
              <span>Partida acumulativa</span>
            </label>
          </fieldset>
          <fieldset className="capacity-options" disabled={disabled}>
            <legend>Número máximo de jugadores</legend>
            <div className="capacity-buttons">
              {[2, 3, 4, 5, 6].map((number) => (
                <label key={number} className={capacity === number ? 'chosen' : ''}>
                  <input
                    type="radio"
                    name="capacity"
                    value={number}
                    checked={capacity === number}
                    onChange={() => setCapacity(number)}
                    aria-label={`${number} jugadores`}
                  />
                  <span aria-hidden="true">{number}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button className="primary-button" disabled={disabled}>
            Crear sala <span aria-hidden="true">↗</span>
          </button>
        </form>
        <form
          className="room-form join-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit({ type: 'room:join', operationId: crypto.randomUUID(), code }, 'join');
          }}
        >
          <span className="section-number">02</span>
          <h2>Ya tengo una invitación</h2>
          <p className="muted">Pide el código al anfitrión y toma tu lugar.</p>
          <div className="field">
            <label htmlFor="room-code">Código de la sala</label>
            <input
              id="room-code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              maxLength={8}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXXXXXX"
              disabled={disabled}
            />
          </div>
          <button className="secondary-button" disabled={disabled}>
            Unirme a la sala
          </button>
          <div className="join-decoration" aria-hidden="true">
            ♠ <i>♥</i> ♣
          </div>
          <p className="muted">
            Dos mazos. Diez cartas por jugador. Treinta segundos para cada turno.
          </p>
        </form>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <p className="phase-note">
        Clásica: gana con un cierre 4-3-3. Apuntado: acumula puntos por combinaciones o pintas; gana
        al llegar a +51 o quedar como único jugador activo.
      </p>
    </section>
  );
}
function RoomHeader({ room }: { room: RoomSnapshot }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
  }, [room.id]);
  return (
    <div className="room-heading">
      <div>
        <div className="eyebrow">
          {room.mode === 'classic' ? 'MODALIDAD CLÁSICA' : 'MODALIDAD APUNTADO'} ·{' '}
          {room.players.length}/{room.capacity} JUGADORES
        </div>
        <h1>{room.name}</h1>
      </div>
      {room.status === 'waiting' && (
        <div className="invite-code">
          <span>CÓDIGO DE SALA</span>
          <strong data-testid="room-code">{room.code}</strong>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(room.code)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? 'Copiado' : 'Copiar código'}
          </button>
        </div>
      )}
    </div>
  );
}
function Roster({ room, playerId }: { room: RoomSnapshot; playerId: string }) {
  return (
    <ul className="player-list" aria-label="Jugadores en la sala">
      {room.players.map((player) => (
        <li
          key={player.id}
          className={room.round?.turnPlayerId === player.id ? 'active-player' : ''}
        >
          <span className="player-avatar" aria-hidden="true">
            {player.displayName.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>
              {player.displayName}
              {player.id === playerId ? ' (tú)' : ''}
            </strong>
            <span>
              {player.id === room.hostId ? 'Anfitrión' : 'Jugador'}
              {room.round ? ` · ${player.cardCount} cartas` : ''}
              {player.eliminated ? ' · Eliminado' : ''}
              {player.roundForfeited
                ? ' · Perdió la ronda por inactividad'
                : player.consecutiveTimeouts > 0
                  ? ` · ${player.consecutiveTimeouts}/3 turnos automáticos`
                  : ''}
            </span>
          </div>
          {player.score !== null && (
            <span className="score-tag">
              {player.score > 0 ? '+' : ''}
              {player.score} pts
            </span>
          )}
          {room.round?.turnPlayerId === player.id && <span className="turn-tag">Su turno</span>}
        </li>
      ))}
    </ul>
  );
}
function WaitingRoom({
  room,
  playerId,
  disabled,
}: {
  room: RoomSnapshot;
  playerId: string;
  disabled: boolean;
}) {
  const host = room.hostId === playerId;
  const command = (type: 'room:leave' | 'room:start') =>
    void sendGameCommand({
      type,
      gameId: room.id,
      expectedVersion: room.version,
      operationId: crypto.randomUUID(),
    });
  return (
    <section className="room-waiting">
      <RoomHeader room={room} />
      <div className="waiting-grid">
        <div>
          <h2>La mesa se está reuniendo</h2>
          <p className="muted">
            Comparte el código para que tus amigos se unan. La modalidad queda fija para esta
            partida.
          </p>
          <Roster room={room} playerId={playerId} />
        </div>
        <aside className="start-panel">
          <span aria-hidden="true">♣</span>
          <h2>{room.players.length < 2 ? 'Falta buena compañía.' : 'Ya podemos repartir.'}</h2>
          <p>
            {host
              ? 'Cuando todos estén aquí, inicia la partida. Sortearemos quién comienza y repartiremos diez cartas a cada jugador.'
              : 'El anfitrión iniciará la partida cuando estén todos.'}
          </p>
          {host && (
            <button
              className="primary-button"
              onClick={() => command('room:start')}
              disabled={disabled || room.players.length < 2}
            >
              Repartir y empezar <span aria-hidden="true">↗</span>
            </button>
          )}
          <button className="text-button" onClick={() => command('room:leave')} disabled={disabled}>
            Salir de la sala
          </button>
        </aside>
      </div>
    </section>
  );
}
function useRemaining(room: RoomSnapshot, receivedAt: number, roundTripMs: number) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(timer);
  }, []);
  const deadline =
    receivedAt + Date.parse(room.round!.deadlineAt) - Date.parse(room.serverTime) - roundTripMs / 2;
  return Math.min(
    room.round!.phase === 'decision' ? 2 : room.turnSeconds,
    Math.max(0, Math.ceil((deadline - now) / 1000)),
  );
}
function Table({
  room,
  playerId,
  disabled,
  receivedAt,
  roundTripMs,
}: {
  room: RoomSnapshot;
  playerId: string;
  disabled: boolean;
  receivedAt: number;
  roundTripMs: number;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [closure, setClosure] = useState<Closure | ''>('');
  const round = room.round!;
  const mine = round.turnPlayerId === playerId;
  const eliminated = room.players.find((player) => player.id === playerId)?.eliminated;
  const forfeited = room.players.find((player) => player.id === playerId)?.roundForfeited;
  const remaining = useRemaining(room, receivedAt, roundTripMs);
  useTurnWarning(
    `${room.id}:${round.number}:${round.turnNo}`,
    remaining,
    mine && !eliminated && !forfeited && round.phase !== 'decision',
  );
  const turnPlayer = room.players.find((player) => player.id === round.turnPlayerId)!;
  useEffect(() => {
    setSelected(null);
  }, [round.turnNo, round.phase, room.id]);
  useEffect(() => {
    setClosure('');
  }, [round.turnNo, room.id]);
  const playable = !disabled && mine && remaining > 0;
  const base = () => ({
    gameId: room.id,
    operationId: crypto.randomUUID(),
    expectedVersion: room.version,
    roundNo: round.number,
    turnNo: round.turnNo,
  });
  const issue = (command: GameCommand) => void sendGameCommand(command);
  const action = room.lastAction;
  const actor =
    room.players.find((player) => player.id === action?.playerId)?.displayName ?? 'Un jugador';
  const lastMessage =
    action?.type === 'round:forfeit'
      ? `${actor} perdió esta ronda tras tres turnos automáticos consecutivos.`
      : action?.automatic
        ? `${actor} agotó el tiempo. El servidor completó su turno.`
        : action?.type === 'turn:draw'
          ? `${actor} robó una carta.`
          : action?.type === 'turn:discard'
            ? `${actor} descartó una carta.`
            : action?.type === 'turn:pass'
              ? `${actor} pasó el turno.`
              : 'Cartas repartidas. La mesa está lista.';
  return (
    <section className="game-table">
      <RoomHeader room={room} />
      <Roster room={room} playerId={playerId} />
      <div className={`felt ${!mine ? 'felt-waiting' : ''}`}>
        <div className="table-sound">
          <SoundButton />
        </div>
        <div className="turn-heading">
          <div>
            <span className="eyebrow">
              RONDA {round.number} · <span>TURNO {round.turnNo}</span>
            </span>
            <h2>{mine ? 'Es tu turno' : `Turno de ${turnPlayer.displayName}`}</h2>
            <p>
              {!mine
                ? eliminated || forfeited
                  ? 'Sigues la partida como espectador.'
                  : 'Tu mano permanece privada.'
                : round.phase === 'draw'
                  ? 'Roba una carta del mazo o del descarte.'
                  : round.phase === 'discard'
                    ? 'Elige una carta de tu mano para descartar.'
                    : 'Descarte listo. El siguiente jugador podrá jugar en dos segundos.'}
            </p>
          </div>
          <div
            className={`turn-clock ${remaining <= 7 && round.phase !== 'decision' ? 'urgent' : ''}`}
            role="timer"
            aria-label="Tiempo restante"
            data-testid="turn-clock"
          >
            <b>{remaining}</b>
            <span>{round.phase === 'decision' ? 'PAUSA' : 'SEGUNDOS'}</span>
          </div>
        </div>
        <div className="piles">
          <div className="pile">
            <button
              className="stock-card"
              aria-label="Robar del mazo"
              disabled={!playable || round.phase !== 'draw'}
              onClick={() => issue({ type: 'turn:draw', ...base(), source: 'stock' })}
            >
              <span aria-hidden="true">♠</span>
            </button>
            <strong>Mazo de robo</strong>
            <span>{round.stockCount} cartas</span>
          </div>
          <DiscardPile
            cards={round.discardPile ?? (round.discardTop ? [round.discardTop] : [])}
            canDraw={playable && round.phase === 'draw'}
            draw={() => issue({ type: 'turn:draw', ...base(), source: 'discard' })}
            face={(card) => <CardFace card={card} />}
            name={cardName}
          />
        </div>
        <p className="last-action" role="status">
          {lastMessage}
        </p>
      </div>
      <div className="hand-heading">
        <div>
          <h2>
            {eliminated ? (
              'Sigues en la mesa como espectador'
            ) : (
              <>
                Tu mano <span>{room.hand.length} cartas</span>
              </>
            )}
          </h2>
          <p className="muted">
            {eliminated
              ? 'Estás eliminado. Puedes consultar las actas y ver el resultado final.'
              : forfeited
                ? 'Perdiste esta ronda por inactividad. Volverás en el próximo reparto si sigues en la partida.'
                : 'Solo tú puedes ver estas cartas.'}
          </p>
        </div>
      </div>
      {!!room.hand.length && (
        <SortableHand
          key={`${playerId}:${room.id}:${round.number}`}
          cards={room.hand}
          storageKey={`apuntado:hand:${playerId}:${room.id}:${round.number}`}
          selected={selected}
          select={setSelected}
          cardName={cardName}
          face={(card) => <CardFace card={card} />}
        />
      )}
      <div className="turn-controls">
        {mine && round.phase === 'discard' && (
          <div className="discard-actions">
            <fieldset className="discard-intent" disabled={!playable}>
              <legend>Al descartar</legend>
              <div className="discard-intent-options">
                {discardIntents
                  .filter(
                    ({ value }) =>
                      room.mode === 'apuntado' || value === '' || value === 'combinaciones',
                  )
                  .map(({ value, label }) => (
                    <label key={value} className={closure === value ? 'chosen' : ''}>
                      <input
                        type="radio"
                        name="discard-intent"
                        value={value}
                        checked={closure === value}
                        onChange={() => setClosure(value)}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
              </div>
            </fieldset>
            <button
              className="primary-button"
              disabled={!playable || selected === null}
              onClick={() => {
                if (selected !== null)
                  issue({
                    type: 'turn:discard',
                    ...base(),
                    cardNo: selected,
                    ...(closure ? { closure } : {}),
                  });
              }}
            >
              {closure
                ? closure === 'toque'
                  ? 'Descartar y tocar'
                  : 'Descartar y cerrar'
                : 'Descartar carta seleccionada'}
            </button>
          </div>
        )}
        {mine && round.phase === 'decision' && (
          <div className="decision-actions">
            <button
              className="secondary-button"
              disabled={!playable}
              onClick={() => issue({ type: 'round:close', ...base(), closure: 'combinaciones' })}
            >
              Cerrar por combinaciones
            </button>
            {room.mode === 'apuntado' && (
              <>
                <button
                  className="secondary-button"
                  disabled={!playable}
                  onClick={() => issue({ type: 'round:close', ...base(), closure: 'pintas' })}
                >
                  Cerrar por pintas
                </button>
                <button
                  className="secondary-button"
                  disabled={!playable}
                  onClick={() => issue({ type: 'round:close', ...base(), closure: 'toque' })}
                >
                  Tocar
                </button>
              </>
            )}
            <p role="status">El turno avanza automáticamente en {remaining} s.</p>
          </div>
        )}
        {remaining === 0 && (
          <p className="muted" role="status">
            Tiempo agotado. Esperando la confirmación del servidor…
          </p>
        )}
        <p className="phase-note">
          Tienes 30 segundos para robar y descartar. Después de un descarte manual, el turno pasa en
          dos segundos. Tres turnos propios consecutivos completados por el servidor te hacen perder
          la ronda.
        </p>
      </div>
      <p className="phase-note">
        {room.mode === 'classic'
          ? 'Cierre válido: combinaciones de 4, 3 y 3 cartas.'
          : 'Combinaciones 4-3-3 o 5-5: +10. Diez cartas del mismo palo: +25. Toque: una o dos sobrantes, hasta 5 puntos, sin premio y sin autoeliminarte. Ases y figuras valen 10.'}
      </p>
    </section>
  );
}
export default function GameHub() {
  const game = useSelector((state: RootState) => state.game);
  const auth = useSelector((state: RootState) => state.auth);
  const disabled = auth.connection !== 'online' || !!game.pending;
  return (
    <div className="game-hub">
      {game.error && (
        <div className="game-error" role="alert">
          <span>{game.error}</span>
          {game.retryRequired ? (
            <button onClick={() => void retryGameCommand()} disabled={auth.connection !== 'online'}>
              Reintentar la misma acción
            </button>
          ) : (
            <button onClick={() => void syncGame()} disabled={auth.connection !== 'online'}>
              Actualizar mesa
            </button>
          )}
        </div>
      )}
      {game.pending && !game.retryRequired && (
        <div className="pending-action" role="status">
          Confirmando la acción…
        </div>
      )}
      {!game.loaded ? (
        <div className="loading-room" role="status">
          Recuperando tu lugar en la mesa…
        </div>
      ) : !game.room ? (
        <RoomForms disabled={disabled} />
      ) : game.room.status === 'waiting' ? (
        <WaitingRoom room={game.room} playerId={auth.session!.player.id} disabled={disabled} />
      ) : game.room.result ? (
        <section>
          <RoomHeader room={game.room} />
          <Roster room={game.room} playerId={auth.session!.player.id} />
          <RoundOutcome room={game.room} playerId={auth.session!.player.id} disabled={disabled} />
        </section>
      ) : game.room.round ? (
        <Table
          room={game.room}
          playerId={auth.session!.player.id}
          disabled={disabled}
          receivedAt={game.receivedAt}
          roundTripMs={game.roundTripMs}
        />
      ) : (
        <p>La partida está en pausa.</p>
      )}
    </div>
  );
}
