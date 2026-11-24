import type { PoolClient } from 'pg';
import type { GameMode, LastAction, RoomSnapshot } from '@apuntado/contracts';
import { assertTable, cards, type TableState } from './domain.js';
import type { RuleProfile } from './rules/model.js';
import { readHistory, readReport } from './settlement-store.js';

export interface GameRow extends RuleProfile {
  game_id: string;
  name: string;
  join_code: string;
  host_player_id: string;
  mode: GameMode;
  turn_seconds: number;
  capacity: number;
  version: number;
  status: 'waiting' | 'active' | 'paused' | 'cancelled' | 'finished' | 'between-rounds';
  last_action: LastAction | null;
}
export interface MemberRow {
  player_id: string;
  display_name: string;
  seat: number;
  left_at: Date | null;
  score: number;
  eliminated_at_round: number | null;
  played: boolean;
}
export const gameSelect = `SELECT g.*,r.mode,r.turn_seconds,r.combination_reward,r.suit_reward,r.touch_max,r.elimination_score,r.victory_score FROM game g JOIN rule_profile r USING(profile_id)`;
export async function members(client: PoolClient, gameId: string): Promise<MemberRow[]> {
  return (
    await client.query<MemberRow>(
      `SELECT p.player_id,p.display_name,m.seat,m.left_at,s.score,m.eliminated_at_round,
      EXISTS(SELECT 1 FROM round_participation rp WHERE rp.game_id=m.game_id AND rp.player_id=m.player_id) AS played
      FROM participation m JOIN current_score s USING(game_id,player_id)
    JOIN player p USING(player_id) WHERE game_id=$1 ORDER BY seat`,
      [gameId],
    )
  ).rows;
}
export async function loadTable(
  client: PoolClient,
  gameId: string,
): Promise<{ roundNo: number; state: TableState }> {
  const round = (
    await client.query(`SELECT * FROM round WHERE game_id=$1 AND status='open'`, [gameId])
  ).rows[0];
  if (!round) throw new Error('Open round missing');
  const roster = (
    await client.query<{ player_id: string; forfeited: boolean }>(
      `SELECT rp.player_id,rp.forfeited FROM round_participation rp JOIN participation p USING(game_id,player_id)
    WHERE rp.game_id=$1 AND rp.round_no=$2 ORDER BY p.seat`,
      [gameId, round.round_no],
    )
  ).rows;
  const ids = roster.map((row) => row.player_id);
  const state: TableState = {
    players: ids,
    forfeited: roster.filter((row) => row.forfeited).map((row) => row.player_id),
    hands: Object.fromEntries(ids.map((id) => [id, []])),
    stock: [],
    discard: [],
    turnPlayerId: round.turn_player_id,
    turnNo: round.turn_no,
    phase: round.phase,
    startedAt: round.turn_started_at.getTime(),
    deadlineAt: round.turn_deadline_at.getTime(),
  };
  const positions = (
    await client.query(
      `SELECT card_no,zone,owner_id FROM card_position WHERE game_id=$1 AND round_no=$2 ORDER BY ordinal`,
      [gameId, round.round_no],
    )
  ).rows;
  for (const row of positions) {
    if (row.zone === 'hand') state.hands[row.owner_id]!.push(row.card_no);
    else (row.zone === 'stock' ? state.stock : state.discard).push(row.card_no);
  }
  assertTable(state);
  return { roundNo: round.round_no, state };
}
export async function saveTable(
  client: PoolClient,
  gameId: string,
  roundNo: number,
  state: TableState,
) {
  assertTable(state);
  await client.query(
    `UPDATE round SET phase=$3,turn_player_id=$4,turn_no=$5,turn_started_at=$6,turn_deadline_at=$7
    WHERE game_id=$1 AND round_no=$2`,
    [
      gameId,
      roundNo,
      state.phase,
      state.turnPlayerId,
      state.turnNo,
      new Date(state.startedAt),
      new Date(state.deadlineAt),
    ],
  );
  const positions: { card_no: number; zone: string; owner_id: string | null; ordinal: number }[] =
    [];
  for (const [ownerId, hand] of Object.entries(state.hands))
    hand.forEach((cardNo, ordinal) =>
      positions.push({ card_no: cardNo, zone: 'hand', owner_id: ownerId, ordinal }),
    );
  for (const zone of ['stock', 'discard'] as const)
    state[zone].forEach((cardNo, ordinal) =>
      positions.push({ card_no: cardNo, zone, owner_id: null, ordinal }),
    );
  // Only the open round is rewritten. Closed-round evidence is never changed.
  await client.query('DELETE FROM card_position WHERE game_id=$1 AND round_no=$2', [
    gameId,
    roundNo,
  ]);
  await client.query(
    `INSERT INTO card_position(game_id,round_no,card_no,zone,owner_id,ordinal)
    SELECT $1,$2,x.* FROM jsonb_to_recordset($3::jsonb) AS x(card_no smallint,zone text,owner_id uuid,ordinal smallint)`,
    [gameId, roundNo, JSON.stringify(positions)],
  );
}
const catalog = new Map(cards().map((card) => [card.cardNo, card]));
export async function snapshot(
  client: PoolClient,
  game: GameRow,
  playerId: string,
  now: number,
): Promise<RoomSnapshot> {
  const roster = (await members(client, game.game_id)).filter(
    (row) => !row.left_at || (game.status === 'finished' && row.played),
  );
  if (!roster.some((row) => row.player_id === playerId && !row.left_at))
    throw new Error('Snapshot requested outside membership');
  const table = game.status === 'active' ? await loadTable(client, game.game_id) : null;
  const state = table?.state;
  const history = await readHistory(client, game.game_id);
  const activity = (
    await client.query(
      `SELECT player_id,timeout_streak,forfeited FROM round_participation WHERE game_id=$1
     AND round_no=(SELECT max(round_no) FROM round WHERE game_id=$1)`,
      [game.game_id],
    )
  ).rows;
  return {
    id: game.game_id,
    name: game.name,
    code: game.join_code,
    mode: game.mode,
    hostId: game.host_player_id,
    capacity: game.capacity,
    status: game.status as RoomSnapshot['status'],
    version: game.version,
    players: roster.map((row) => ({
      id: row.player_id,
      displayName: row.display_name,
      seat: row.seat,
      cardCount: state?.hands[row.player_id]?.length ?? 0,
      score: game.mode === 'apuntado' ? row.score : null,
      eliminated: row.eliminated_at_round !== null,
      roundForfeited:
        activity.find((entry) => entry.player_id === row.player_id)?.forfeited ?? false,
      consecutiveTimeouts:
        activity.find((entry) => entry.player_id === row.player_id)?.timeout_streak ?? 0,
    })),
    hand: (state?.hands[playerId] ?? []).map((id) => catalog.get(id)!),
    turnSeconds: game.turn_seconds,
    serverTime: new Date(now).toISOString(),
    lastAction: game.last_action,
    history,
    result:
      history.length && (game.status === 'between-rounds' || game.status === 'finished')
        ? await readReport(client, game.game_id, history.at(-1)!.number)
        : null,
    round:
      state && table
        ? {
            number: table.roundNo,
            turnNo: state.turnNo,
            phase: state.phase,
            turnPlayerId: state.turnPlayerId,
            startedAt: new Date(state.startedAt).toISOString(),
            deadlineAt: new Date(state.deadlineAt).toISOString(),
            stockCount: state.stock.length,
            discardTop: catalog.get(state.discard.at(-1) ?? 0) ?? null,
            discardPile: state.discard.map((id) => catalog.get(id)!),
          }
        : null,
  };
}
