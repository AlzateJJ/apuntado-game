import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { cards } from '../../apps/server/src/game/domain.js';
import { loadTable, saveTable } from '../../apps/server/src/game/store.js';
// Test-only deterministic deals, directly in an isolated schema; never a public application endpoint.
export async function arrangeTable(
  pool: Pool,
  gameId: string,
  hands: Record<string, number[]>,
  actorId: string,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT game_id FROM game WHERE game_id=$1 FOR UPDATE', [gameId]);
    const { roundNo, state } = await loadTable(client, gameId);
    const used = Object.values(hands).flat();
    assert.equal(
      new Set(used).size,
      used.length,
      'Fixture hands must use different physical cards',
    );
    state.hands = hands;
    const remaining = cards()
      .map((card) => card.cardNo)
      .filter((id) => !used.includes(id));
    state.discard = [remaining.pop()!];
    state.stock = remaining;
    state.turnPlayerId = actorId;
    state.phase = 'decision';
    await saveTable(client, gameId, roundNo, state);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
