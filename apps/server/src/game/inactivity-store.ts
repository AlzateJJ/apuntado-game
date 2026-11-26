import type { PoolClient } from 'pg';
import { TIMEOUT_LIMIT } from '@apuntado/contracts';
import type { TableState } from './domain.js';
import type { GameRow, MemberRow } from './store.js';
import { settleInactivity } from './rules/inactivity.js';
import { saveSettlement } from './settlement-store.js';
import { excludeWithdrawn } from './rules/withdrawal.js';

export async function recordTimeout(
  client: PoolClient,
  game: GameRow,
  roundNo: number,
  state: TableState,
  actorId: string,
  roster: MemberRow[],
  now: number,
) {
  const streak = (
    await client.query(
      `UPDATE round_participation SET timeout_streak=timeout_streak+1
     WHERE game_id=$1 AND round_no=$2 AND player_id=$3 RETURNING timeout_streak`,
      [game.game_id, roundNo, actorId],
    )
  ).rows[0].timeout_streak as number;
  if (streak < TIMEOUT_LIMIT) return { forfeited: false, closed: false, finished: false };
  await client.query(
    'UPDATE round_participation SET forfeited=true WHERE game_id=$1 AND round_no=$2 AND player_id=$3',
    [game.game_id, roundNo, actorId],
  );
  state.forfeited.push(actorId);
  const eligible = state.players.filter((id) => !state.forfeited.includes(id));
  // An absent host must not prevent those still playing from dealing the following round.
  if (game.host_player_id === actorId)
    await client.query('UPDATE game SET host_player_id=$2 WHERE game_id=$1', [
      game.game_id,
      eligible[0],
    ]);
  if (eligible.length > 1) return { forfeited: true, closed: false, finished: false };
  const players = state.players.map((id) => ({
    id,
    hand: state.hands[id]!,
    score: roster.find((row) => row.player_id === id)!.score,
  }));
  const settled = settleInactivity(players, eligible[0]!, game);
  excludeWithdrawn(
    settled,
    roster.filter((row) => row.surrendered_at).map((row) => row.player_id),
    game,
  );
  await saveSettlement(
    client,
    game.game_id,
    roundNo,
    actorId,
    'inactivity',
    game.version + 1,
    settled,
    now,
  );
  return { forfeited: true, closed: true, finished: settled.finished === true };
}
