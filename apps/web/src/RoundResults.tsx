import { useEffect, useRef, useState } from 'react';
import type { PlayingCard, RoomSnapshot, RoundReport } from '@apuntado/contracts';
import { fetchRoundReport, sendGameCommand } from './session';

const closures = {
  combinaciones: 'combinaciones',
  pintas: 'diez pintas',
  toque: 'toque',
  inactivity: 'inactividad',
  abandonment: 'abandono',
};
const explanations = {
  'classic-close': 'Cierre 4-3-3',
  combinations: 'Cierre por combinaciones',
  suit: 'Diez cartas del mismo palo',
  touch: 'Toque aceptado, sin premio',
  'minimum-penalty': 'Menor descuento posible',
  inactivity: 'Ronda perdida por tres turnos automáticos consecutivos',
  'last-in-round': 'Último jugador de la ronda, sin premio de cierre',
  withdrawal: 'Abandonó la partida',
};
const groupNames = { group: 'Grupo', run: 'Escalera', suit: 'Mismo palo' };
const suits = { C: '♣', D: '♦', H: '♥', S: '♠' };
const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
function EvidenceCards({ cards }: { cards: PlayingCard[] }) {
  return (
    <span className="evidence-cards">
      {cards.map((card) => (
        <span
          key={card.cardNo}
          className={`evidence-card ${card.suit === 'H' || card.suit === 'D' ? 'red-suit' : ''}`}
        >
          {{ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[card.rank] ?? card.rank}
          {suits[card.suit]}
          <small title="Copia del mazo">{card.deck}</small>
        </span>
      ))}
    </span>
  );
}
export function RoundEvidence({ report }: { report: RoundReport }) {
  const actor = report.players.find((player) => player.id === report.actorId)!;
  const roundWinner = report.players.find((player) => player.id === report.roundWinnerId);
  const scored = report.players.some((player) => player.delta !== null);
  return (
    <section className="round-evidence" aria-label={`Acta de ronda ${report.number}`}>
      <div className="eyebrow">RONDA {report.number} · ACTA CONFIRMADA</div>
      <h2>
        {report.closure === 'abandonment'
          ? roundWinner
            ? `${roundWinner.displayName} ganó la ronda por abandono`
            : 'La ronda terminó por abandono'
          : report.closure === 'inactivity'
            ? `${roundWinner?.displayName} ganó la ronda por inactividad`
            : `${actor.displayName} cerró por ${closures[report.closure]}`}
      </h2>
      <p className="muted">
        Las manos de esta ronda ya son públicas. Cada carta aparece una sola vez en su evaluación.
      </p>
      {scored && (
        <div className="score-table-wrap">
          <table className="score-table">
            <caption>Liquidación de la ronda {report.number}</caption>
            <thead>
              <tr>
                <th>Jugador</th>
                <th>Anterior</th>
                <th>Ronda</th>
                <th>Total</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {report.players.map((player) => (
                <tr key={player.id}>
                  <th scope="row">{player.displayName}</th>
                  <td>{signed(player.before!)}</td>
                  <td>{signed(player.delta!)}</td>
                  <td>
                    <strong>{signed(player.after!)}</strong>
                  </td>
                  <td>
                    {player.withdrawn
                      ? 'Abandonó'
                      : player.eliminated
                        ? 'Eliminado'
                        : player.roundForfeited
                          ? 'Perdió esta ronda'
                          : player.id === report.winnerId
                            ? 'Ganador'
                            : 'Activo'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="evidence-grid">
        {report.players.map((player) => (
          <article className="player-evidence" key={player.id}>
            <h3>{player.displayName}</h3>
            <p>
              {!scored &&
              player.id !== report.actorId &&
              report.closure !== 'inactivity' &&
              report.closure !== 'abandonment' &&
              !player.withdrawn &&
              !player.roundForfeited
                ? 'Combinaciones encontradas'
                : explanations[player.explanation]}
            </p>
            {player.groups.map((group, index) => (
              <div className="evidence-group" key={index}>
                <span>
                  {groupNames[group.kind]} · {group.cards.length} cartas
                </span>
                <EvidenceCards cards={group.cards} />
              </div>
            ))}
            <div className="evidence-group leftovers">
              <span>
                {player.leftovers.length
                  ? `Sobrantes${scored ? ` · ${player.penalty} puntos` : ''}`
                  : 'Sin sobrantes'}
              </span>
              <EvidenceCards cards={player.leftovers} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
export function RoundOutcome({
  room,
  playerId,
  disabled,
}: {
  room: RoomSnapshot;
  playerId: string;
  disabled: boolean;
}) {
  const report = room.result!;
  const winnerId = room.outcome ? room.outcome.winnerId : report.winnerId;
  const winner = room.players.find((player) => player.id === winnerId);
  const issue = (type: 'round:next' | 'room:leave') =>
    void sendGameCommand({
      type,
      gameId: room.id,
      expectedVersion: room.version,
      operationId: crypto.randomUUID(),
    });
  return (
    <>
      <section className="round-outcome" aria-live="polite">
        <span className="eyebrow">
          {room.status === 'finished' ? 'PARTIDA TERMINADA' : 'RONDA TERMINADA'}
        </span>
        <h2>
          {winner
            ? `${winner.id === playerId ? '¡Ganaste' : `Ganó ${winner.displayName}`}!`
            : room.status === 'finished'
              ? 'Partida terminada.'
              : 'Una nueva mano nos espera.'}
        </h2>
        <p>
          {room.outcome?.reason === 'abandonment'
            ? winner
              ? 'Gana quien queda como único jugador que sigue en la partida. No se otorga un premio de cierre por abandono.'
              : 'La partida terminó sin jugadores activos.'
            : report.closure === 'abandonment'
              ? 'La ronda terminó por abandono. Se descuentan los sobrantes de quienes perdieron la ronda, sin premio de cierre.'
              : report.closure === 'inactivity'
                ? room.mode === 'classic'
                  ? 'La partida Clásica termina al quedar un solo jugador en la ronda.'
                  : 'La ronda termina por inactividad. No se otorga premio de cierre; se descuentan los sobrantes de quienes perdieron la ronda.'
                : room.mode === 'classic'
                  ? 'El cierre 4-3-3 termina la partida Clásica, sin puntaje acumulado.'
                  : winner
                    ? 'Victoria por alcanzar +51 puntos o quedar como único jugador activo.'
                    : 'Se conservan los puntos. Quienes llegaron a −101 o menos quedan fuera del próximo reparto.'}
        </p>
        {room.status === 'finished' ? (
          <button
            className="primary-button"
            disabled={disabled}
            onClick={() => issue('room:leave')}
          >
            Volver al inicio
          </button>
        ) : room.hostId === playerId ? (
          <button
            className="primary-button"
            disabled={disabled}
            onClick={() => issue('round:next')}
          >
            Repartir siguiente ronda
          </button>
        ) : (
          <p>Esperando a que el anfitrión reparta la siguiente ronda.</p>
        )}
      </section>
      <RoundEvidence report={report} />
    </>
  );
}
export function RoundHistory({ room, disabled }: { room: RoomSnapshot; disabled: boolean }) {
  const [selected, setSelected] = useState('');
  const [report, setReport] = useState<RoundReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  if (!room.history.length) return null;
  async function load(number: string) {
    setSelected(number);
    setReport(null);
    setError('');
    const request = ++sequence.current;
    if (!number) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const value = await fetchRoundReport(room.id, Number(number));
      if (request === sequence.current) setReport(value);
    } catch (cause) {
      if (request === sequence.current)
        setError(cause instanceof Error ? cause.message : 'No pudimos recuperar el acta.');
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }
  return (
    <details className="round-history">
      <summary>Consultar rondas anteriores ({room.history.length})</summary>
      <div className="field">
        <label htmlFor="history-round">Ronda cerrada</label>
        <select
          id="history-round"
          value={selected}
          disabled={disabled}
          onChange={(event) => void load(event.target.value)}
        >
          <option value="">Elige una ronda</option>
          {room.history.map((round) => (
            <option key={round.number} value={round.number}>
              Ronda {round.number} · {closures[round.closure]}
            </option>
          ))}
        </select>
      </div>
      {loading && <p role="status">Cargando acta…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button disabled={disabled} onClick={() => void load(selected)}>
            Reintentar consulta
          </button>
        </div>
      )}
      {report && <RoundEvidence report={report} />}
    </details>
  );
}
