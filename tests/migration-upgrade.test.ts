import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { runner } from 'node-pg-migrate';

test('phase-two upgrade reconstructs the original starter across seat gaps and wrapped turns', async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
    throw new Error('Dedicated test database required');
  const schema = `upgrade_${randomUUID().replaceAll('-', '')}`;
  const settings = {
    databaseUrl,
    schema,
    createSchema: true,
    dir: fileURLToPath(new URL('../database/migrations', import.meta.url)),
    direction: 'up' as const,
    migrationsTable: 'schema_migrations',
    log: () => {},
  };
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await runner({ ...settings, count: 3 });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids)
      await pool.query('INSERT INTO player(player_id,display_name) VALUES($1,$2)', [
        id,
        `Player ${id.slice(0, 5)}`,
      ]);
    const expected = new Map<string, string>();
    for (const [turnNo, currentIndex, initialIndex] of [
      [8, 1, 0],
      [9, 0, 1],
      [1, 2, 2],
    ]) {
      const gameId = randomUUID();
      expected.set(gameId, ids[initialIndex!]!);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO game(game_id,profile_id,status) VALUES($1,'apuntado-v2','active')`,
          [gameId],
        );
        for (let i = 0; i < 3; i++)
          await client.query('INSERT INTO participation(game_id,player_id,seat) VALUES($1,$2,$3)', [
            gameId,
            ids[i],
            [1, 3, 6][i],
          ]);
        await client.query(
          `INSERT INTO round(game_id,round_no,status,phase,turn_player_id,turn_no) VALUES($1,1,'open','draw',$2,$3)`,
          [gameId, ids[currentIndex!], turnNo],
        );
        for (const id of ids)
          await client.query(
            'INSERT INTO round_participation(game_id,round_no,player_id) VALUES($1,1,$2)',
            [gameId, id],
          );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    await runner(settings);
    const rows = (await pool.query('SELECT game_id,initial_player_id FROM round')).rows;
    for (const row of rows) assert.equal(row.initial_player_id, expected.get(row.game_id));
    assert.equal(rows.length, 3);
    await runner(settings);
    assert.equal((await pool.query('SELECT * FROM schema_migrations')).rowCount, 5);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
