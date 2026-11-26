import type { PoolClient } from 'pg';
import { discard, pass, type RandomIndex } from './domain.js';
import { loadTable, members, saveTable, type GameRow, type MemberRow } from './store.js';
import { settleInactivity } from './rules/inactivity.js';
import { excludeWithdrawn } from './rules/withdrawal.js';
import { saveSettlement } from './settlement-store.js';

async function withdrawFromRound(
  client: PoolClient,
  game: GameRow,
  roster: MemberRow[],
  playerId: string,
  now: number,
  random: RandomIndex,
) {
  const { roundNo, state } = await loadTable(client, game.game_id);
  if (!state.players.includes(playerId)) return;
  const eligible = state.players.filter((id) => id !== playerId && !state.forfeited.includes(id));
  const closing = eligible.length <= 1;
  // Freeze ten cards for evidence; normalize an unfinished draw before passing or settling.
  if ((closing || state.turnPlayerId === playerId) && state.phase === 'discard') {
    const hand = state.hands[state.turnPlayerId]!;
    discard(state, hand[random(hand.length)]!);
  }
  if (state.turnPlayerId === playerId) {
    state.phase = 'decision';
    pass(state, now, game.turn_seconds);
  }
  await saveTable(client, game.game_id, roundNo, state);
  await client.query(
    'UPDATE round_participation SET withdrawn=true WHERE game_id=$1 AND round_no=$2 AND player_id=$3',
    [game.game_id, roundNo, playerId],
  );
  if (!closing) return;
  const players = state.players.map((id) => ({
    id,
    hand: state.hands[id]!,
    score: roster.find((row) => row.player_id === id)!.score,
  }));
  const settled = excludeWithdrawn(
    settleInactivity(players, eligible[0] ?? null, game),
    roster.filter((row) => row.surrendered_at).map((row) => row.player_id),
    game,
  );
  await saveSettlement(
    client,
    game.game_id,
    roundNo,
    playerId,
    'abandonment',
    game.version + 1,
    settled,
    now,
  );
}

async function finishBetweenRounds(
  client: PoolClient,
  game: GameRow,
  roster: MemberRow[],
  now: number,
) {
  const active = roster.filter((row) => !row.left_at && row.eliminated_at_round === null);
  if (active.length > 1) return;
  // The final match outcome is separate: already committed round evidence stays untouched.
  await client.query(
    "UPDATE game SET status='finished',finished_at=$2,winner_player_id=$3,finish_reason='abandonment' WHERE game_id=$1",
    [game.game_id, new Date(now), active[0]?.player_id ?? null],
  );
}

async function transferHost(
  client: PoolClient,
  game: GameRow,
  roster: MemberRow[],
  playerId: string,
) {
  if (game.host_player_id !== playerId) return;
  const remaining = roster.filter((row) => !row.left_at);
  const forfeited = (
    await client.query<{ player_id: string }>(
      `SELECT player_id FROM round_participation WHERE game_id=$1 AND forfeited
       AND round_no=(SELECT max(round_no) FROM round WHERE game_id=$1)`,
      [game.game_id],
    )
  ).rows.map((row) => row.player_id);
  const contenders = remaining.filter((row) => row.eliminated_at_round === null);
  const next =
    contenders.find((row) => !forfeited.includes(row.player_id)) ?? contenders[0] ?? remaining[0];
  if (next)
    await client.query('UPDATE game SET host_player_id=$2 WHERE game_id=$1', [
      game.game_id,
      next.player_id,
    ]);
}

export async function surrender(
  client: PoolClient,
  game: GameRow,
  playerId: string,
  now: number,
  random: RandomIndex,
) {
  await client.query(
    'UPDATE participation SET left_at=$3,surrendered_at=$3 WHERE game_id=$1 AND player_id=$2',
    [game.game_id, playerId, new Date(now)],
  );
  const roster = await members(client, game.game_id);
  if (game.status === 'active' || game.status === 'paused')
    await withdrawFromRound(client, game, roster, playerId, now, random);
  else await finishBetweenRounds(client, game, roster, now);
  await transferHost(client, game, await members(client, game.game_id), playerId);
}
