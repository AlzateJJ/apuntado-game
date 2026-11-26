import type { PoolClient } from 'pg';
import type { RoundClosure, RoundReport, RoundSummary } from '@apuntado/contracts';
import type { Settlement } from './rules/model.js';
import { cards } from './domain.js';

const summary = (row: Record<string, any>): RoundSummary => ({
  number: row.round_no,
  actorId: row.actor_id,
  closure: row.closure,
  roundWinnerId: row.round_winner_id,
  winnerId: row.winner_id,
  next: row.next_action,
  closedAt: row.closed_at.toISOString(),
});
export async function readHistory(client: PoolClient, gameId: string): Promise<RoundSummary[]> {
  return (
    await client.query('SELECT * FROM round_result WHERE game_id=$1 ORDER BY round_no', [gameId])
  ).rows.map(summary);
}
const catalog = new Map(cards().map((card) => [card.cardNo, card]));
export async function readReport(
  client: PoolClient,
  gameId: string,
  roundNo: number,
): Promise<RoundReport> {
  const result = (
    await client.query(
      `SELECT rr.*,g.profile_id,r.mode FROM round_result rr
    JOIN game g USING(game_id) JOIN rule_profile r USING(profile_id) WHERE rr.game_id=$1 AND rr.round_no=$2`,
      [gameId, roundNo],
    )
  ).rows[0];
  if (!result) throw new Error('Committed round result missing');
  const entries = (
    await client.query(
      `SELECT e.*,p.display_name,m.delta,rp.forfeited,rp.withdrawn,
    COALESCE((SELECT sum(delta) FROM score_movement s WHERE s.game_id=e.game_id AND s.player_id=e.player_id AND s.round_no<e.round_no),0)::integer AS before,
    (pt.eliminated_at_round=e.round_no) IS TRUE AS eliminated
    FROM hand_evaluation e JOIN player p USING(player_id) JOIN participation pt USING(game_id,player_id)
    JOIN round_participation rp USING(game_id,round_no,player_id)
    LEFT JOIN score_movement m USING(game_id,round_no,player_id)
    WHERE e.game_id=$1 AND e.round_no=$2 ORDER BY pt.seat`,
      [gameId, roundNo],
    )
  ).rows;
  const evidence = (
    await client.query(
      `SELECT * FROM evaluation_card WHERE game_id=$1 AND round_no=$2
    ORDER BY player_id,group_no,position_in_group,card_no`,
      [gameId, roundNo],
    )
  ).rows;
  return {
    ...summary(result),
    profileId: result.profile_id,
    players: entries.map((entry) => {
      const groups = new Map<number, RoundReport['players'][number]['groups'][number]>();
      const leftovers = [];
      for (const row of evidence.filter((card) => card.player_id === entry.player_id)) {
        const card = catalog.get(row.card_no)!;
        if (row.group_no === null) leftovers.push(card);
        else {
          if (!groups.has(row.group_no))
            groups.set(row.group_no, { kind: row.group_kind, cards: [] });
          groups.get(row.group_no)!.cards.push(card);
        }
      }
      const scored = result.mode === 'apuntado';
      return {
        id: entry.player_id,
        displayName: entry.display_name,
        groups: [...groups.values()],
        leftovers,
        penalty: entry.penalty,
        explanation: entry.explanation_code,
        before: scored ? entry.before : null,
        delta: scored ? entry.delta : null,
        after: scored ? entry.before + entry.delta : null,
        eliminated: entry.eliminated,
        roundForfeited: entry.forfeited,
        withdrawn: entry.withdrawn,
      };
    }),
  };
}
export async function saveSettlement(
  client: PoolClient,
  gameId: string,
  roundNo: number,
  actorId: string,
  closure: RoundClosure,
  version: number,
  settled: Settlement,
  now: number,
) {
  const finished = settled.finished || settled.winnerId !== null;
  await client.query(
    `INSERT INTO round_result(game_id,round_no,actor_id,closure,winner_id,next_action,committed_version,closed_at,round_winner_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      gameId,
      roundNo,
      actorId,
      closure,
      settled.winnerId,
      finished ? 'home' : 'next-round',
      version,
      new Date(now),
      settled.roundWinnerId !== undefined
        ? settled.roundWinnerId
        : closure === 'toque'
          ? null
          : actorId,
    ],
  );
  for (const player of settled.players) {
    if (player.delta !== null)
      await client.query(
        `INSERT INTO score_movement(game_id,round_no,player_id,delta) VALUES($1,$2,$3,$4)`,
        [gameId, roundNo, player.id, player.delta],
      );
    await client.query(
      `INSERT INTO hand_evaluation(game_id,round_no,player_id,penalty,explanation_code,evaluator_version) VALUES($1,$2,$3,$4,$5,1)`,
      [gameId, roundNo, player.id, player.penalty, player.explanation],
    );
    const evidence = player.groups.flatMap((group, index) =>
      group.cards.map((card, position) => ({
        card_no: card.cardNo,
        group_no: index + 1,
        group_kind: group.kind,
        position_in_group: position,
      })),
    );
    const ungrouped = player.leftovers.map((card) => ({
      card_no: card.cardNo,
      group_no: null,
      group_kind: null,
      position_in_group: null,
    }));
    await client.query(
      `INSERT INTO evaluation_card(game_id,round_no,player_id,card_no,group_no,group_kind,position_in_group)
      SELECT $1,$2,$3,x.* FROM jsonb_to_recordset($4::jsonb) AS x(card_no smallint,group_no smallint,group_kind text,position_in_group smallint)`,
      [gameId, roundNo, player.id, JSON.stringify([...evidence, ...ungrouped])],
    );
    if (player.eliminated)
      await client.query(
        `UPDATE participation SET eliminated_at_round=$3 WHERE game_id=$1 AND player_id=$2`,
        [gameId, player.id, roundNo],
      );
  }
  await client.query(
    `UPDATE round SET status='closed',phase='closed' WHERE game_id=$1 AND round_no=$2`,
    [gameId, roundNo],
  );
  await client.query(
    `UPDATE game SET status=$2,finished_at=$3,winner_player_id=$4,finish_reason=$5 WHERE game_id=$1`,
    [
      gameId,
      finished ? 'finished' : 'between-rounds',
      finished ? new Date(now) : null,
      settled.winnerId,
      finished ? (closure === 'abandonment' ? 'abandonment' : 'round') : null,
    ],
  );
}
