import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { io as clientIO } from 'socket.io-client';
import type { GameCommand, RoomSnapshot } from '@apuntado/contracts';
import { GameService } from '../apps/server/src/game/service.js';
import { createApplication } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { arrangeTable } from './helpers/arrange-table.js';
import { full433, full55, suit10, touch5, loose } from './helpers/rules-fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Use a dedicated _test database');
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  statement_timeout: 10000,
});
let now = Date.now();
const games = new GameService(pool, { now: () => now, random: (max) => max - 1 });
before(async () => {
  await runner({
    databaseUrl,
    schema,
    createSchema: true,
    dir: fileURLToPath(new URL('../database/migrations', import.meta.url)),
    direction: 'up',
    migrationsTable: 'schema_migrations',
    log: () => {},
  });
});
after(async () => {
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
});
async function player() {
  const id = randomUUID();
  await pool.query('INSERT INTO player(player_id,display_name) VALUES($1,$2)', [
    id,
    `Player ${id.slice(0, 6)}`,
  ]);
  return id;
}
async function waiting(size = 2, mode: 'classic' | 'apuntado' = 'apuntado', capacity = size) {
  const ids = await Promise.all(Array.from({ length: size }, () => player()));
  const created = await games.execute(ids[0]!, {
    type: 'room:create',
    operationId: randomUUID(),
    name: 'Mesa de prueba',
    mode,
    capacity,
  });
  const initial = (await games.current(ids[0]!))!;
  for (const id of ids.slice(1))
    await games.execute(id, { type: 'room:join', operationId: randomUUID(), code: initial.code });
  return { ids, gameId: created.gameId, room: (await games.current(ids[0]!))! };
}
async function playing(size = 2, mode: 'classic' | 'apuntado' = 'apuntado') {
  const setup = await waiting(size, mode);
  await games.execute(setup.ids[0]!, {
    type: 'room:start',
    operationId: randomUUID(),
    gameId: setup.gameId,
    expectedVersion: setup.room.version,
  });
  return { ...setup, room: (await games.current(setup.ids[0]!))! };
}
const base = (room: RoomSnapshot) => ({
  operationId: randomUUID(),
  gameId: room.id,
  expectedVersion: room.version,
  roundNo: room.round!.number,
  turnNo: room.round!.turnNo,
});
async function manualTurn(gameId: string, viewer: string) {
  let view = (await games.current(viewer))!;
  const actor = view.round!.turnPlayerId;
  await games.execute(actor, { type: 'turn:draw', ...base(view), source: 'stock' });
  view = (await games.current(actor))!;
  await games.execute(actor, {
    type: 'turn:discard',
    ...base(view),
    cardNo: view.hand.at(-1)!.cardNo,
  });
  now += 2000;
  assert.equal(await games.expireGame(gameId), true);
}
async function expireTarget(gameId: string, target: string) {
  let view = (await games.current(target))!;
  for (let i = 0; view.round!.turnPlayerId !== target && i < 6; i++) {
    await manualTurn(gameId, target);
    view = (await games.current(target))!;
  }
  assert.equal(view.round!.turnPlayerId, target);
  now = Date.parse(view.round!.deadlineAt);
  return games.expireGame(gameId);
}

const surrenderCommand = (room: RoomSnapshot) => ({
  type: 'game:surrender' as const,
  operationId: randomUUID(),
  gameId: room.id,
  expectedVersion: room.version,
});

test('surrender from every turn phase frees the seat and awards the remaining player without a bonus', async () => {
  for (const mode of ['classic', 'apuntado'] as const) {
    for (const phase of ['draw', 'discard', 'decision'] as const) {
      for (const leavesOnOwnTurn of [true, false]) {
        const { ids, gameId, room } = await playing(2, mode);
        const actor = room.round!.turnPlayerId;
        const other = ids.find((id) => id !== actor)!;
        const leaving = leavesOnOwnTurn ? actor : other;
        const survivor = leavesOnOwnTurn ? other : actor;
        if (phase !== 'draw')
          await games.execute(actor, { type: 'turn:draw', ...base(room), source: 'stock' });
        if (phase === 'decision') {
          const drawn = (await games.current(actor))!;
          await games.execute(actor, {
            type: 'turn:discard',
            ...base(drawn),
            cardNo: drawn.hand.at(-1)!.cardNo,
          });
        }
        // Deliberately stale: a concurrent draw/turn transition must not trap a surrender.
        const command = surrenderCommand(room);
        const receipt = await games.execute(leaving, command);
        assert.deepEqual(await games.execute(leaving, command), receipt);
        assert.equal(await games.current(leaving), null);
        const result = (await games.current(survivor))!;
        assert.equal(result.status, 'finished');
        assert.deepEqual(result.outcome, { winnerId: survivor, reason: 'abandonment' });
        assert.equal(result.result!.closure, 'abandonment');
        assert.equal(
          result.result!.players.find((p) => p.id === survivor)!.delta,
          mode === 'classic' ? null : 0,
        );
        const lost = result.result!.players.find((p) => p.id === leaving)!;
        assert.equal(lost.withdrawn, true);
        assert.equal(lost.explanation, 'withdrawal');
        for (const p of result.result!.players)
          assert.equal(p.groups.flatMap((g) => g.cards).length + p.leftovers.length, 10);
        assert.equal(await games.expireGame(gameId), false);
        await integrity(gameId);
        await assert.rejects(
          games.execute(leaving, { type: 'room:join', operationId: randomUUID(), code: room.code }),
          { code: 'ROOM_STARTED' },
        );
        if (phase === 'draw')
          await games.execute(leaving, {
            type: 'room:create',
            operationId: randomUUID(),
            name: 'Otra partida',
            mode,
            capacity: 2,
          });
        else {
          const newRoom = await waiting(2, mode, 3);
          await games.execute(leaving, {
            type: 'room:join',
            operationId: randomUUID(),
            code: newRoom.room.code,
          });
          assert.equal((await games.current(leaving))!.id, newRoom.gameId);
        }
        assert.notEqual((await games.current(leaving))!.id, gameId);
        assert.deepEqual(
          await games.execute(leaving, command),
          receipt,
          'retry cannot remove the new membership',
        );
        assert.notEqual((await games.current(leaving))!.id, gameId);
      }
    }
  }
});

test('surrender preserves another player’s clock, transfers host, skips the seat and freezes private evidence', async () => {
  const { ids, gameId, room } = await playing(3);
  const host = ids[0]!,
    actor = room.round!.turnPlayerId;
  await games.execute(actor, { type: 'turn:draw', ...base(room), source: 'stock' });
  const before = (await games.current(actor))!;
  const frozen = (await games.current(host))!.hand;
  await games.execute(host, surrenderCommand(room));
  let view = (await games.current(actor))!;
  assert.equal(view.status, 'active');
  assert.equal(view.hostId, ids[1]);
  assert.deepEqual(view.round, before.round);
  assert.deepEqual(view.hand, before.hand);
  assert.equal(view.result, null);
  assert.equal(view.players.find((p) => p.id === host)!.withdrawn, true);
  assert.ok(view.players.every((p) => !('hand' in p)));
  await games.execute(actor, {
    type: 'turn:discard',
    ...base(view),
    cardNo: view.hand.at(-1)!.cardNo,
  });
  now += 2000;
  await games.expireGame(gameId);
  view = (await games.current(actor))!;
  assert.equal(view.round!.turnPlayerId, ids[1]);
  for (let i = 0; i < 3; i++) await expireTarget(gameId, ids[1]!);
  const closed = (await games.current(actor))!;
  const evidence = closed.result!.players.find((p) => p.id === host)!;
  assert.deepEqual(
    [...evidence.groups.flatMap((g) => g.cards), ...evidence.leftovers]
      .map((c) => c.cardNo)
      .sort((a, b) => a - b),
    frozen.map((c) => c.cardNo).sort((a, b) => a - b),
  );
  assert.equal(evidence.explanation, 'withdrawal');
  assert.notEqual(closed.outcome?.winnerId, host);
  await integrity(gameId);
});

test('surrender on one’s own turn advances to the next eligible seat with a fresh 30-second turn', async () => {
  const { ids, gameId, room } = await playing(3);
  const actor = room.round!.turnPlayerId;
  await games.execute(actor, { type: 'turn:draw', ...base(room), source: 'stock' });
  now += 5000;
  await games.execute(actor, surrenderCommand(room));
  const view = (await games.current(ids[0]!))!;
  assert.equal(view.round!.turnPlayerId, ids[0]);
  assert.equal(view.round!.phase, 'draw');
  assert.equal(view.round!.turnNo, room.round!.turnNo + 1);
  assert.equal(Date.parse(view.round!.deadlineAt), now + 30000);
  await manualTurn(gameId, ids[0]!);
  await manualTurn(gameId, ids[0]!);
  assert.equal((await games.current(ids[0]!))!.round!.turnPlayerId, ids[0]);
  await integrity(gameId);
});

test('leaving between rounds finishes independently of immutable round scores and lets the winner leave', async () => {
  const setup = await prepareClose();
  await games.execute(setup.actor, setup.command);
  const before = (await games.current(setup.actor))!;
  assert.equal(before.status, 'between-rounds');
  const survivor = setup.ids.find((id) => id !== setup.actor)!;
  await games.execute(setup.actor, surrenderCommand(before));
  const after = (await games.current(survivor))!;
  assert.equal(after.status, 'finished');
  assert.deepEqual(after.outcome, { winnerId: survivor, reason: 'abandonment' });
  assert.deepEqual(after.result, before.result);
  assert.deepEqual(after.history, before.history);
  await games.execute(survivor, surrenderCommand(after));
  assert.equal(await games.current(survivor), null);
  const row = (
    await pool.query('SELECT winner_player_id,finish_reason FROM game WHERE game_id=$1', [
      setup.gameId,
    ])
  ).rows[0];
  assert.deepEqual(row, { winner_player_id: survivor, finish_reason: 'abandonment' });
});

test('departure before a regular closure cannot win, and subsequent rounds exclude the surrendered seat', async () => {
  const { ids, gameId } = await playing(3);
  const [departing, actor, other] = ids as [string, string, string];
  const used = [...full433(), ...full433(2)];
  const spare = Array.from({ length: 104 }, (_, i) => i + 1)
    .filter((id) => !used.includes(id))
    .slice(0, 10);
  await arrangeTable(
    pool,
    gameId,
    { [departing]: full433(2), [actor]: full433(), [other]: spare },
    actor,
  );
  await games.execute(departing, surrenderCommand((await games.current(departing))!));
  const open = (await games.current(actor))!;
  await games.execute(actor, { type: 'round:close', ...base(open), closure: 'combinaciones' });
  const closed = (await games.current(actor))!;
  assert.equal(closed.status, 'between-rounds');
  assert.equal(closed.hostId, actor);
  assert.equal(closed.result!.players.find((p) => p.id === departing)!.explanation, 'withdrawal');
  await games.execute(actor, {
    type: 'round:next',
    operationId: randomUUID(),
    gameId,
    expectedVersion: closed.version,
  });
  const next = (await games.current(actor))!;
  assert.equal(next.round!.number, 2);
  assert.equal(next.players.find((p) => p.id === departing)!.cardCount, 0);
  assert.equal(
    (
      await pool.query('SELECT * FROM round_participation WHERE game_id=$1 AND round_no=2', [
        gameId,
      ])
    ).rowCount,
    2,
  );
  assert.deepEqual(
    await games.report(actor, { requestId: randomUUID(), gameId, roundNo: 1 }),
    closed.result,
  );
});

test('only members can surrender; racing retries and timeout settle once without leaving a stuck game', async () => {
  const { ids, gameId, room } = await playing(2, 'classic');
  const command = surrenderCommand(room);
  await assert.rejects(games.execute(await player(), command), { code: 'NOT_A_MEMBER' });
  now = Date.parse(room.round!.deadlineAt);
  const [first, second] = await Promise.all([
    games.execute(ids[0]!, command),
    games.execute(ids[0]!, command),
    games.expireGame(gameId),
  ]);
  assert.deepEqual(first, second);
  assert.equal((await games.current(ids[1]!))!.status, 'finished');
  assert.equal(
    (await pool.query('SELECT * FROM round_result WHERE game_id=$1', [gameId])).rowCount,
    1,
  );
  await integrity(gameId);
});

test('a surrendering host transfers control to a player still participating in the current round', async () => {
  const { ids, gameId } = await playing(4);
  for (let i = 0; i < 3; i++) await expireTarget(gameId, ids[1]!);
  const before = (await games.current(ids[0]!))!;
  assert.equal(before.players.find((p) => p.id === ids[1])!.roundForfeited, true);
  await games.execute(ids[0]!, surrenderCommand(before));
  const next = (await games.current(ids[2]!))!;
  assert.equal(next.status, 'active');
  assert.equal(next.hostId, ids[2]);
  await integrity(gameId);
});

test('a failed surrender transaction keeps membership, hands, scores and outcome intact for a safe retry', async () => {
  const { ids, gameId, room } = await playing();
  const command = surrenderCommand(room);
  const before = await games.current(ids[0]!);
  await pool.query(`CREATE FUNCTION reject_surrender() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'surrender publication failure'; END $$;
    CREATE TRIGGER fail_surrender BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_surrender()`);
  try {
    await assert.rejects(games.execute(ids[0]!, command), /surrender publication failure/);
    assert.deepEqual(await games.current(ids[0]!), before);
    assert.equal(
      (await pool.query('SELECT * FROM round_result WHERE game_id=$1', [gameId])).rowCount,
      0,
    );
    assert.equal(
      (await pool.query('SELECT * FROM score_movement WHERE game_id=$1', [gameId])).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query('SELECT * FROM participation WHERE game_id=$1 AND left_at IS NOT NULL', [
          gameId,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await pool.query('DROP TRIGGER fail_surrender ON outbox; DROP FUNCTION reject_surrender()');
  }
  await games.execute(ids[0]!, command);
  assert.equal(await games.current(ids[0]!), null);
  assert.equal((await games.current(ids[1]!))!.status, 'finished');
});

test('a host can surrender between rounds with three players; remaining players can deal again', async () => {
  const { ids, gameId } = await playing(3);
  const [host, nextHost, other] = ids as [string, string, string];
  const used = [...full433(), ...full433(2)];
  const spare = Array.from({ length: 104 }, (_, i) => i + 1)
    .filter((id) => !used.includes(id))
    .slice(0, 10);
  await arrangeTable(
    pool,
    gameId,
    { [host]: full433(), [nextHost]: full433(2), [other]: spare },
    host,
  );
  await games.execute(host, {
    type: 'round:close',
    ...base((await games.current(host))!),
    closure: 'combinaciones',
  });
  const before = (await games.current(host))!;
  await games.execute(host, surrenderCommand(before));
  const after = (await games.current(nextHost))!;
  assert.equal(after.status, 'between-rounds');
  assert.equal(after.hostId, nextHost);
  assert.deepEqual(after.result, before.result);
  await games.execute(nextHost, {
    type: 'round:next',
    operationId: randomUUID(),
    gameId,
    expectedVersion: after.version,
  });
  assert.equal((await games.current(nextHost))!.round!.number, 2);
  assert.equal(await games.current(host), null);
});

test('three consecutive own timeouts forfeit only the round; Apuntado keeps the seat and resets next round', async () => {
  const { ids, gameId } = await playing(2);
  const absent = ids[1]!,
    survivor = ids[0]!;
  for (let i = 1; i <= 2; i++) {
    await expireTarget(gameId, absent);
    const view = (await games.current(absent))!;
    assert.equal(view.status, 'active');
    assert.equal(view.players.find((p) => p.id === absent)!.consecutiveTimeouts, i);
  }
  const restarted = new GameService(pool, { now: () => now });
  assert.equal(
    (await restarted.current(absent))!.players.find((p) => p.id === absent)!.consecutiveTimeouts,
    2,
  );
  await expireTarget(gameId, absent);
  const result = (await games.current(survivor))!;
  assert.equal(result.status, 'between-rounds');
  assert.equal(result.result!.closure, 'inactivity');
  assert.equal(result.result!.roundWinnerId, survivor);
  assert.equal(result.result!.winnerId, null);
  assert.equal(result.result!.players.find((p) => p.id === survivor)!.delta, 0);
  const lost = result.result!.players.find((p) => p.id === absent)!;
  assert.equal(lost.roundForfeited, true);
  assert.equal(lost.delta, lost.penalty === 0 ? 0 : -lost.penalty);
  assert.equal(await games.expireGame(gameId), false);
  await games.execute(survivor, {
    type: 'round:next',
    operationId: randomUUID(),
    gameId,
    expectedVersion: result.version,
  });
  const next = (await games.current(absent))!;
  assert.equal(next.round!.number, 2);
  assert.equal(next.hand.length, 10);
  assert.ok(next.players.every((p) => !p.roundForfeited && p.consecutiveTimeouts === 0));
});

test('manual discard resets consecutive timeouts and normal two-second transitions never penalize', async () => {
  const { ids, gameId } = await playing();
  const target = ids[1]!;
  await expireTarget(gameId, target);
  await expireTarget(gameId, target);
  await manualTurn(gameId, target); // Opponent.
  await manualTurn(gameId, target); // Previously absent player completes a turn.
  let view = (await games.current(target))!;
  assert.equal(view.players.find((p) => p.id === target)!.consecutiveTimeouts, 0);
  assert.equal(view.lastAction!.automatic, false);
  for (let i = 0; i < 2; i++) await expireTarget(gameId, target);
  view = (await games.current(target))!;
  assert.equal(view.status, 'active');
  assert.equal(view.players.find((p) => p.id === target)!.consecutiveTimeouts, 2);
});

test('three-player rounds skip forfeited seats, keep hands private and transfer an inactive host', async () => {
  const { ids, gameId } = await playing(3, 'classic');
  const absent = ids[0]!;
  for (let i = 0; i < 3; i++) await expireTarget(gameId, absent);
  let view = (await games.current(absent))!;
  assert.equal(view.status, 'active');
  assert.equal(view.hostId, ids[1]);
  assert.equal(view.result, null);
  assert.equal(view.hand.length, 10);
  const frozen = view.hand;
  await assert.rejects(
    games.execute(absent, { type: 'turn:draw', ...base(view), source: 'stock' }),
    { code: 'ROUND_FORFEITED' },
  );
  const outsider = await player();
  await assert.rejects(
    games.execute(outsider, { type: 'room:join', operationId: randomUUID(), code: view.code }),
    { code: 'ROOM_STARTED' },
  );
  for (let i = 0; i < 4; i++) {
    assert.notEqual((await games.current(absent))!.round!.turnPlayerId, absent);
    await manualTurn(gameId, absent);
  }
  view = (await games.current(absent))!;
  assert.deepEqual(view.hand, frozen);
  for (let i = 0; i < 3; i++) await expireTarget(gameId, ids[1]!);
  const final = (await games.current(ids[2]!))!;
  assert.equal(final.status, 'finished');
  assert.equal(final.result!.winnerId, ids[2]);
  assert.ok(final.result!.players.every((p) => p.delta === null));
  await integrity(gameId);
});

test('discard-and-close settles atomically and an invalid declaration rolls the discard back', async () => {
  for (const mode of ['classic', 'apuntado'] as const) {
    const setup = await prepareClose(mode);
    await pool.query("UPDATE round SET phase='draw' WHERE game_id=$1 AND status='open'", [
      setup.gameId,
    ]);
    let view = (await games.current(setup.actor))!;
    await games.execute(setup.actor, { type: 'turn:draw', ...base(view), source: 'stock' });
    view = (await games.current(setup.actor))!;
    const valid = {
      type: 'turn:discard' as const,
      ...base(view),
      cardNo: view.hand.at(-1)!.cardNo,
      closure: 'combinaciones' as const,
    };
    await assert.rejects(games.execute(setup.actor, { ...valid, cardNo: view.hand[0]!.cardNo }), {
      code: 'INVALID_CLOSE',
    });
    assert.deepEqual(await games.current(setup.actor), view);
    const receipt = await games.execute(setup.actor, valid);
    assert.deepEqual(await games.execute(setup.actor, valid), receipt);
    const settled = (await games.current(setup.actor))!;
    assert.equal(settled.result!.closure, 'combinaciones');
    assert.equal(settled.result!.roundWinnerId, setup.actor);
  }
});

test('public discard snapshots match the pile exactly and exclude held and stock cards', async () => {
  const { ids, room, gameId } = await playing();
  const top = room.round!.discardTop!;
  const actor = room.round!.turnPlayerId;
  await games.execute(actor, { type: 'turn:draw', ...base(room), source: 'discard' });
  const drawn = (await games.current(actor))!;
  assert.ok(drawn.hand.some((card) => card.cardNo === top.cardNo));
  assert.equal(drawn.round!.discardPile.length, 0);
  await games.execute(actor, {
    type: 'turn:discard',
    ...base(drawn),
    cardNo: drawn.hand[0]!.cardNo,
  });
  const views = await Promise.all(ids.map((id) => games.current(id)));
  assert.deepEqual(views[0]!.round!.discardPile, views[1]!.round!.discardPile);
  const pile = views[0]!.round!.discardPile;
  assert.equal(pile.length, 1);
  for (const view of views)
    assert.ok(view!.hand.every((card) => !pile.some((p) => p.cardNo === card.cardNo)));
  await integrity(gameId);
});
async function integrity(gameId: string) {
  const rows = (
    await pool.query('SELECT card_no,zone,owner_id FROM card_position WHERE game_id=$1', [gameId])
  ).rows;
  assert.equal(rows.length, 104);
  assert.equal(new Set(rows.map((row) => row.card_no)).size, 104);
}
async function prepareClose(mode: 'classic' | 'apuntado' = 'apuntado', hand = full433()) {
  const setup = await playing(2, mode);
  const actor = setup.ids[1]!;
  await arrangeTable(pool, setup.gameId, { [actor]: hand, [setup.ids[0]!]: full433(2) }, actor);
  const room = (await games.current(actor))!;
  return {
    ...setup,
    actor,
    room,
    command: { type: 'round:close' as const, ...base(room), closure: 'combinaciones' as const },
  };
}
test('Clásica commits a single public acta with no scores, finishes and returns each player home', async () => {
  const { actor, ids, command, gameId } = await prepareClose('classic');
  const before = (await games.current(ids[0]!))!;
  assert.equal(before.result, null);
  assert.deepEqual(before.history, []);
  const receipt = await games.execute(actor, command);
  const result = (await games.current(ids[0]!))!;
  assert.equal(result.status, 'finished');
  assert.equal(result.round, null);
  assert.deepEqual(result.hand, []);
  assert.equal(result.result!.winnerId, actor);
  assert.equal(result.result!.next, 'home');
  assert.equal(result.result!.players.length, 2);
  for (const p of result.result!.players) {
    assert.equal(p.delta, null);
    assert.equal(p.groups.flatMap((g) => g.cards).length + p.leftovers.length, 10);
  }
  assert.equal(
    (await pool.query('SELECT * FROM score_movement WHERE game_id=$1', [gameId])).rowCount,
    0,
  );
  assert.equal(await games.expireGame(gameId), false);
  await assert.rejects(
    games.execute(result.hostId, {
      type: 'round:next',
      operationId: randomUUID(),
      gameId,
      expectedVersion: result.version,
    }),
    { code: 'ROUND_NOT_FINISHED' },
  );
  await games.execute(actor, {
    type: 'room:leave',
    operationId: randomUUID(),
    gameId,
    expectedVersion: result.version,
  });
  assert.equal(await games.current(actor), null);
  assert.deepEqual(await games.execute(actor, command), receipt);
  assert.equal(
    (await games.current(ids[0]!))!.result!.winnerId,
    actor,
    'winner remains visible after returning home',
  );
  const historical = await games.report(actor, { requestId: randomUUID(), gameId, roundNo: 1 });
  assert.deepEqual(historical, result.result);
  await games.execute(actor, {
    type: 'room:create',
    operationId: randomUUID(),
    name: 'Otra mesa',
    mode: 'apuntado',
    capacity: 2,
  });
});
test('rejected closures reveal no other hands and preserve points, version and shared deadline', async () => {
  const { actor, ids, command, gameId } = await prepareClose('classic', full55());
  const before = await games.current(actor);
  for (const closure of ['combinaciones', 'pintas', 'toque'])
    await assert.rejects(games.execute(actor, { ...command, operationId: randomUUID(), closure }), {
      code: 'INVALID_CLOSE',
    });
  assert.deepEqual(await games.current(actor), before);
  await assert.rejects(games.report(ids[0]!, { requestId: randomUUID(), gameId, roundNo: 1 }), {
    code: 'REPORT_NOT_AVAILABLE',
  });
  assert.equal(
    (await pool.query('SELECT * FROM hand_evaluation WHERE game_id=$1', [gameId])).rowCount,
    0,
  );
  await assert.rejects(games.execute(await player(), command), { code: 'NOT_A_MEMBER' });
  await assert.rejects(games.execute(ids[0]!, command), { code: 'NOT_YOUR_TURN' });
  await assert.rejects(games.execute(actor, { ...command, expectedVersion: 0 }), {
    code: 'VERSION_CONFLICT',
  });
});
test('closure requires decision and the original deadline; timeout never closes a complete hand', async () => {
  const setup = await playing();
  let room = setup.room;
  const actor = room.round!.turnPlayerId;
  await assert.rejects(
    games.execute(actor, { type: 'round:close', ...base(room), closure: 'combinaciones' }),
    { code: 'WRONG_PHASE' },
  );
  const prepared = await prepareClose();
  room = prepared.room;
  now = Date.parse(room.round!.deadlineAt);
  await assert.rejects(games.execute(prepared.actor, prepared.command), { code: 'TURN_EXPIRED' });
  assert.equal(await games.expireGame(room.id), true);
  const after = (await games.current(prepared.actor))!;
  assert.equal(after.round!.turnNo, room.round!.turnNo + 1);
  assert.equal(after.result, null);
  assert.equal(
    (await pool.query('SELECT * FROM round_result WHERE game_id=$1', [room.id])).rowCount,
    0,
  );
});
test('concurrent close retries settle once; changed payload and separate competing close are rejected', async () => {
  const { actor, command, gameId } = await prepareClose();
  const receipts = await Promise.all([
    games.execute(actor, command),
    games.execute(actor, command),
  ]);
  assert.deepEqual(receipts[0], receipts[1]);
  for (const [table, count] of [
    ['round_result', 1],
    ['score_movement', 2],
    ['hand_evaluation', 2],
    ['evaluation_card', 20],
  ] as const)
    assert.equal(
      (await pool.query(`SELECT * FROM ${table} WHERE game_id=$1`, [gameId])).rowCount,
      count,
    );
  await assert.rejects(games.execute(actor, { ...command, closure: 'pintas' }), {
    code: 'OPERATION_REUSED',
  });
  const other = await prepareClose();
  const raced = await Promise.allSettled([
    games.execute(other.actor, other.command),
    games.execute(other.actor, { ...other.command, operationId: randomUUID() }),
  ]);
  assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    (raced.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code,
    'VERSION_CONFLICT',
  );
});
test('a failure after writing the final result rolls back evaluations, scores, status and receipt', async () => {
  const { actor, command, gameId } = await prepareClose('classic');
  const before = await games.current(actor);
  await pool.query(`CREATE FUNCTION fail_finished() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.event_type='GameFinished' THEN RAISE EXCEPTION 'simulated settlement failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_finished BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_finished()`);
  try {
    await assert.rejects(games.execute(actor, command), /simulated settlement failure/);
  } finally {
    await pool.query('DROP TRIGGER fail_finished ON outbox; DROP FUNCTION fail_finished()');
  }
  assert.deepEqual(await games.current(actor), before);
  for (const table of ['round_result', 'score_movement', 'hand_evaluation', 'evaluation_card'])
    assert.equal(
      (await pool.query(`SELECT * FROM ${table} WHERE game_id=$1`, [gameId])).rowCount,
      0,
    );
  assert.equal(
    (
      await pool.query('SELECT * FROM processed_operation WHERE game_id=$1 AND operation_id=$2', [
        gameId,
        command.operationId,
      ])
    ).rowCount,
    0,
  );
  await games.execute(actor, command);
  assert.equal((await games.current(actor))!.status, 'finished');
});
test('Apuntado records the accepted touch and its exact leftovers without a bonus', async () => {
  const { actor, command } = await prepareClose('apuntado', touch5());
  await games.execute(actor, { ...command, closure: 'toque' });
  const report = (await games.current(actor))!.result!;
  const self = report.players.find((p) => p.id === actor)!;
  assert.equal(self.delta, -5);
  assert.equal(self.penalty, 5);
  assert.equal(self.after, -5);
  assert.equal(self.leftovers.length, 1);
  assert.equal(self.leftovers[0]!.rank, 5);
  assert.equal(report.next, 'next-round');
});
test('Apuntado settlement failure rolls back actual score movements and can retry the same operation', async () => {
  const { actor, command, gameId } = await prepareClose();
  const before = await games.current(actor);
  await pool.query(`CREATE FUNCTION fail_scoring() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.event_type='RoundClosed' THEN RAISE EXCEPTION 'simulated scoring failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_scoring BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_scoring()`);
  try {
    await assert.rejects(games.execute(actor, command), /simulated scoring failure/);
  } finally {
    await pool.query('DROP TRIGGER fail_scoring ON outbox; DROP FUNCTION fail_scoring()');
  }
  assert.deepEqual(await games.current(actor), before);
  assert.equal(
    (await pool.query('SELECT * FROM score_movement WHERE game_id=$1', [gameId])).rowCount,
    0,
  );
  await games.execute(actor, command);
  assert.equal((await games.current(actor))!.players.find((p) => p.id === actor)!.score, 10);
});
test('later rounds preserve evidence, rotate the starter and exclude eliminated hosts from hands and turns', async () => {
  const setup = await playing(3);
  const [host, middle, actor] = setup.ids as [string, string, string];
  const hands = { [host]: loose(), [middle]: full433(2), [actor]: full433() };
  let firstReport;
  for (let number = 1; number <= 2; number++) {
    await arrangeTable(pool, setup.gameId, hands, actor);
    const before = (await games.current(actor))!;
    await games.execute(actor, { type: 'round:close', ...base(before), closure: 'combinaciones' });
    const closed = (await games.current(host))!;
    assert.equal(closed.status, 'between-rounds');
    assert.equal(closed.players.find((p) => p.id === host)!.score, -76 * number);
    assert.equal(closed.players.find((p) => p.id === host)!.eliminated, number === 2);
    if (number === 1) firstReport = closed.result;
    await assert.rejects(
      games.execute(middle, {
        type: 'round:next',
        operationId: randomUUID(),
        gameId: setup.gameId,
        expectedVersion: closed.version,
      }),
      { code: 'HOST_ONLY' },
    );
    const nextCommand = {
      type: 'round:next',
      operationId: randomUUID(),
      gameId: setup.gameId,
      expectedVersion: closed.version,
    };
    const receipts = await Promise.all([
      games.execute(host, nextCommand),
      games.execute(host, nextCommand),
    ]);
    assert.deepEqual(receipts[0], receipts[1]);
    const next = (await games.current(host))!;
    assert.equal(next.round!.number, number + 1);
    assert.equal(next.round!.turnNo, 1);
    assert.equal(Date.parse(next.round!.deadlineAt) - Date.parse(next.round!.startedAt), 30000);
    assert.equal(next.round!.turnPlayerId, number === 1 ? host : middle);
    assert.equal(next.hand.length, number === 1 ? 10 : 0);
    assert.equal(next.result, null);
  }
  const reconstructed = new GameService(pool, { now: () => now });
  assert.deepEqual(
    await reconstructed.report(host, { requestId: randomUUID(), gameId: setup.gameId, roundNo: 1 }),
    firstReport,
  );
  for (let i = 0; i < 3; i++) {
    const state = (await reconstructed.current(host))!;
    assert.notEqual(state.round!.turnPlayerId, host);
    now = Date.parse(state.round!.deadlineAt);
    await reconstructed.expireGame(setup.gameId);
  }
  assert.equal(
    (await pool.query('SELECT * FROM card_copy WHERE game_id=$1', [setup.gameId])).rowCount,
    104,
  );
  assert.equal(
    (await pool.query('SELECT * FROM card_position WHERE game_id=$1', [setup.gameId])).rowCount,
    312,
  );
  assert.equal(
    (
      await pool.query('SELECT * FROM round_participation WHERE game_id=$1 AND round_no=3', [
        setup.gameId,
      ])
    ).rowCount,
    2,
  );
  await assert.rejects(
    games.report(await player(), { requestId: randomUUID(), gameId: setup.gameId, roundNo: 1 }),
    { code: 'NOT_A_MEMBER' },
  );
  const beforeDeparture = (await games.current(middle))!;
  await games.execute(host, surrenderCommand(beforeDeparture));
  const afterDeparture = (await games.current(middle))!;
  assert.equal(await games.current(host), null);
  assert.equal(afterDeparture.status, 'active');
  assert.equal(afterDeparture.hostId, middle);
  assert.deepEqual(afterDeparture.round, beforeDeparture.round);
  assert.deepEqual(
    await games.report(middle, { requestId: randomUUID(), gameId: setup.gameId, roundNo: 1 }),
    firstReport,
  );
});
test('Apuntado ends when the accumulated award crosses +51 and reports stable previous totals', async () => {
  const setup = await playing();
  const [host, actor] = setup.ids as [string, string];
  for (let number = 1; number <= 3; number++) {
    await arrangeTable(pool, setup.gameId, { [host]: full433(2), [actor]: suit10() }, actor);
    const before = (await games.current(actor))!;
    await games.execute(actor, { type: 'round:close', ...base(before), closure: 'pintas' });
    const after = (await games.current(actor))!;
    const result = after.result!.players.find((p) => p.id === actor)!;
    assert.equal(result.before, (number - 1) * 25);
    assert.equal(result.delta, 25);
    assert.equal(result.after, number * 25);
    assert.equal(after.status, number === 3 ? 'finished' : 'between-rounds');
    if (number < 3)
      await games.execute(host, {
        type: 'round:next',
        operationId: randomUUID(),
        gameId: setup.gameId,
        expectedVersion: after.version,
      });
    else assert.equal(after.result!.winnerId, actor);
  }
  const old = await games.report(actor, {
    requestId: randomUUID(),
    gameId: setup.gameId,
    roundNo: 1,
  });
  assert.equal(old.players.find((p) => p.id === actor)!.after, 25);
});
test('Apuntado also finishes below +51 when the opponent is eliminated', async () => {
  const setup = await playing();
  const [host, actor] = setup.ids as [string, string];
  for (let number = 1; number <= 2; number++) {
    await arrangeTable(pool, setup.gameId, { [host]: loose(), [actor]: full433() }, actor);
    const before = (await games.current(actor))!;
    await games.execute(actor, { type: 'round:close', ...base(before), closure: 'combinaciones' });
    const after = (await games.current(actor))!;
    if (number === 1)
      await games.execute(host, {
        type: 'round:next',
        operationId: randomUUID(),
        gameId: setup.gameId,
        expectedVersion: after.version,
      });
    else {
      assert.equal(after.status, 'finished');
      assert.equal(after.result!.winnerId, actor);
      assert.equal(after.players.find((p) => p.id === actor)!.score, 20);
    }
  }
});
test('create is idempotent across concurrent requests and fixes the selected mode', async () => {
  const id = await player();
  const command = {
    type: 'room:create',
    operationId: randomUUID(),
    name: 'Clásica',
    mode: 'classic',
    capacity: 6,
  };
  const receipts = await Promise.all([games.execute(id, command), games.execute(id, command)]);
  assert.deepEqual(receipts[0], receipts[1]);
  const room = (await games.current(id))!;
  assert.equal(room.mode, 'classic');
  assert.equal(room.players.length, 1);
  assert.equal(room.capacity, 6);
  await assert.rejects(games.execute(id, { ...command, name: 'Otro nombre' }), {
    code: 'OPERATION_REUSED',
  });
  await assert.rejects(games.execute(id, { ...command, operationId: randomUUID() }), {
    code: 'ALREADY_IN_ROOM',
  });
});
test('simultaneous joins cannot overfill a room or duplicate a seat', async () => {
  const { room } = await waiting(1, 'apuntado', 2);
  const ids = await Promise.all([player(), player()]);
  const results = await Promise.allSettled(
    ids.map((id) =>
      games.execute(id, { type: 'room:join', operationId: randomUUID(), code: room.code }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'ROOM_FULL');
  const current = (await games.current(room.hostId))!;
  assert.equal(current.players.length, 2);
  assert.equal(new Set(current.players.map((p) => p.seat)).size, 2);
});
test('one player cannot join two rooms concurrently', async () => {
  const a = await waiting(1, 'classic', 2),
    b = await waiting(1, 'apuntado', 2),
    id = await player();
  const results = await Promise.allSettled(
    [a, b].map(({ room }) =>
      games.execute(id, { type: 'room:join', operationId: randomUUID(), code: room.code }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code,
    'ALREADY_IN_ROOM',
  );
});
test('host departure transfers ownership; the last departure cancels the room; members can rejoin', async () => {
  const setup = await waiting();
  const host = setup.ids[0]!,
    guest = setup.ids[1]!;
  await games.execute(host, {
    type: 'room:leave',
    operationId: randomUUID(),
    gameId: setup.gameId,
    expectedVersion: setup.room.version,
  });
  assert.equal(await games.current(host), null);
  let room = (await games.current(guest))!;
  assert.equal(room.hostId, guest);
  await games.execute(host, {
    type: 'room:join',
    operationId: randomUUID(),
    code: room.code.toLowerCase(),
  });
  room = (await games.current(host))!;
  assert.equal(room.players.length, 2);
  assert.equal(room.hostId, guest);
  for (const id of [host, guest]) {
    room = (await games.current(id))!;
    await games.execute(id, {
      type: 'room:leave',
      operationId: randomUUID(),
      gameId: room.id,
      expectedVersion: room.version,
    });
  }
  assert.equal(
    (await pool.query('SELECT status FROM game WHERE game_id=$1', [setup.gameId])).rows[0].status,
    'cancelled',
  );
});
test('start requires the host and at least two players, and late outsiders cannot join', async () => {
  const solo = await waiting(1, 'classic', 3);
  await assert.rejects(
    games.execute(solo.ids[0]!, {
      type: 'room:start',
      operationId: randomUUID(),
      gameId: solo.gameId,
      expectedVersion: solo.room.version,
    }),
    { code: 'PLAYER_COUNT' },
  );
  const { ids, gameId, room } = await waiting();
  await assert.rejects(
    games.execute(ids[1]!, {
      type: 'room:start',
      operationId: randomUUID(),
      gameId,
      expectedVersion: room.version,
    }),
    { code: 'HOST_ONLY' },
  );
  await games.execute(ids[0]!, {
    type: 'room:start',
    operationId: randomUUID(),
    gameId,
    expectedVersion: room.version,
  });
  await assert.rejects(
    games.execute(await player(), {
      type: 'room:join',
      operationId: randomUUID(),
      code: room.code,
    }),
    { code: 'ROOM_STARTED' },
  );
  const current = (await games.current(ids[0]!))!;
  await assert.rejects(
    games.execute(ids[0]!, {
      type: 'room:leave',
      operationId: randomUUID(),
      gameId,
      expectedVersion: current.version,
    }),
    { code: 'GAME_IN_PROGRESS' },
  );
});
test('both modes deal 104 distinct cards and expose only the requesting player hand', async () => {
  for (const mode of ['classic', 'apuntado'] as const) {
    const { ids, gameId } = await playing(6, mode);
    const views = await Promise.all(ids.map((id) => games.current(id)));
    const allHands = views.flatMap((view) => view!.hand.map((card) => card.cardNo));
    assert.equal(new Set(allHands).size, 60);
    for (const view of views) {
      assert.equal(view!.hand.length, 10);
      assert.equal(view!.round!.stockCount, 43);
      assert.ok(view!.round!.discardTop);
      assert.equal(Date.parse(view!.round!.deadlineAt) - Date.parse(view!.round!.startedAt), 30000);
      assert.ok(view!.players.every((p) => !('hand' in p)));
      assert.ok(!('stock' in view!.round!));
    }
    assert.equal(await games.current(await player()), null);
    await integrity(gameId);
  }
});
test('turn permissions, phase, card ownership and stale versions are enforced', async () => {
  const { ids, room } = await playing();
  const actor = room.round!.turnPlayerId,
    other = ids.find((id) => id !== actor)!;
  await assert.rejects(
    games.execute(other, { type: 'turn:draw', ...base(room), source: 'stock' }),
    { code: 'NOT_YOUR_TURN' },
  );
  await assert.rejects(
    games.execute(await player(), { type: 'turn:draw', ...base(room), source: 'stock' }),
    { code: 'NOT_A_MEMBER' },
  );
  await assert.rejects(games.execute(actor, { type: 'turn:pass', ...base(room) }), {
    code: 'INVALID_PHASE',
  });
  await games.execute(actor, { type: 'turn:draw', ...base(room), source: 'stock' });
  const drawn = (await games.current(actor))!;
  assert.equal(drawn.hand.length, 11);
  assert.equal(drawn.round!.deadlineAt, room.round!.deadlineAt);
  await assert.rejects(
    games.execute(actor, { type: 'turn:draw', ...base(drawn), source: 'stock' }),
    { code: 'INVALID_PHASE' },
  );
  const otherView = (await games.current(other))!;
  await assert.rejects(
    games.execute(actor, {
      type: 'turn:discard',
      ...base(drawn),
      cardNo: otherView.hand[0]!.cardNo,
    }),
    { code: 'CARD_NOT_OWNED' },
  );
  await assert.rejects(
    games.execute(actor, { type: 'turn:discard', ...base(room), cardNo: drawn.hand[0]!.cardNo }),
    { code: 'VERSION_CONFLICT' },
  );
});
test('competing discards apply once; replay works after the turn advances', async () => {
  const { room } = await playing();
  const actor = room.round!.turnPlayerId;
  const drawCommand = { type: 'turn:draw', ...base(room), source: 'discard' };
  const receipt = await games.execute(actor, drawCommand);
  const drawn = (await games.current(actor))!;
  const choices = drawn.hand
    .slice(0, 2)
    .map((card) => ({ type: 'turn:discard', ...base(drawn), cardNo: card.cardNo }));
  const outcomes = await Promise.allSettled(
    choices.map((command) => games.execute(actor, command)),
  );
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  const discarded = (await games.current(actor))!;
  assert.equal(discarded.hand.length, 10);
  assert.equal(discarded.round!.phase, 'decision');
  await assert.rejects(games.execute(actor, { type: 'turn:pass', ...base(discarded) }), {
    code: 'TURN_ADVANCING',
  });
  assert.equal(Date.parse(discarded.round!.deadlineAt), now + 2000);
  now += 1999;
  assert.equal(await games.expireGame(room.id), false);
  now++;
  assert.equal(await games.expireGame(room.id), true);
  assert.deepEqual(await games.execute(actor, drawCommand), receipt);
  await integrity(room.id);
  const after = (await games.current(actor))!;
  assert.equal(after.round!.turnNo, 2);
  assert.equal(after.hand.length, 10);
});
test('timeouts and the two-second discard transition finish exactly one turn at their deadline', async () => {
  for (const phase of ['draw', 'discard', 'decision']) {
    const { room } = await playing();
    const actor = room.round!.turnPlayerId;
    let current = (await games.current(actor))!;
    if (phase !== 'draw') {
      await games.execute(actor, { type: 'turn:draw', ...base(current), source: 'stock' });
      current = (await games.current(actor))!;
    }
    if (phase === 'decision') {
      await games.execute(actor, {
        type: 'turn:discard',
        ...base(current),
        cardNo: current.hand[0]!.cardNo,
      });
      current = (await games.current(actor))!;
    }
    const deadline = Date.parse(current.round!.deadlineAt);
    now = deadline - 1;
    assert.equal(await games.expireGame(room.id), false);
    now = deadline;
    const result = await Promise.all([games.expireGame(room.id), games.expireGame(room.id)]);
    assert.equal(result.filter(Boolean).length, 1);
    const after = (await games.current(actor))!;
    assert.equal(after.hand.length, 10);
    assert.equal(after.round!.turnNo, 2);
    assert.equal(after.lastAction!.automatic, phase !== 'decision');
    assert.equal(
      after.players.find((p) => p.id === actor)!.consecutiveTimeouts,
      phase === 'decision' ? 0 : 1,
    );
    assert.equal(after.version, current.version + 1);
    await integrity(room.id);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM processed_operation WHERE game_id=$1 AND actor_kind='system'",
          [room.id],
        )
      ).rows[0].count,
      '1',
    );
  }
});
test('a command competing with expiration cannot discard twice or skip two seats', async () => {
  const { room } = await playing();
  const actor = room.round!.turnPlayerId;
  await games.execute(actor, { type: 'turn:draw', ...base(room), source: 'stock' });
  const current = (await games.current(actor))!;
  now = Date.parse(current.round!.deadlineAt);
  const results = await Promise.allSettled([
    games.execute(actor, {
      type: 'turn:discard',
      ...base(current),
      cardNo: current.hand[0]!.cardNo,
    }),
    games.expireGame(room.id),
  ]);
  assert.equal(results[0]!.status, 'rejected');
  assert.equal(results[1]!.status, 'fulfilled');
  const after = (await games.current(actor))!;
  assert.equal(after.round!.turnNo, 2);
  assert.equal(after.hand.length, 10);
  await integrity(room.id);
});
test('a restarted service retains deadlines and resumes overdue disconnected players', async () => {
  const { ids, room } = await playing();
  const restarted = new GameService(pool, { now: () => now, random: (max) => max - 1 });
  assert.equal((await restarted.current(ids[0]!))!.round!.deadlineAt, room.round!.deadlineAt);
  now = Date.parse(room.round!.deadlineAt) + 120000;
  await restarted.expireDue();
  const next = (await restarted.current(ids[0]!))!;
  assert.equal(next.round!.turnNo, 2);
  assert.equal(Date.parse(next.round!.deadlineAt), now + 30000);
});
test('a failed outbox insert rolls back cards, round, operation and game status together', async () => {
  const { ids, room } = await waiting();
  await pool.query(`CREATE FUNCTION reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.game_id='${room.id}'::uuid THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_event();`);
  const command = {
    type: 'room:start',
    operationId: randomUUID(),
    gameId: room.id,
    expectedVersion: room.version,
  };
  try {
    await assert.rejects(games.execute(ids[0]!, command), /injected failure/);
    assert.equal((await games.current(ids[0]!))!.status, 'waiting');
    assert.equal(
      (await pool.query('SELECT count(*) FROM card_copy WHERE game_id=$1', [room.id])).rows[0]
        .count,
      '0',
    );
    assert.equal(
      (await pool.query('SELECT count(*) FROM round WHERE game_id=$1', [room.id])).rows[0].count,
      '0',
    );
    assert.equal(
      (
        await pool.query('SELECT count(*) FROM processed_operation WHERE operation_id=$1', [
          command.operationId,
        ])
      ).rows[0].count,
      '0',
    );
  } finally {
    await pool.query('DROP TRIGGER fail_outbox ON outbox; DROP FUNCTION reject_event();');
  }
  await games.execute(ids[0]!, command);
  await integrity(room.id);
});
test('outbox failures retain committed state and a new publisher retries without private data', async () => {
  const { ids, room } = await playing();
  const published: any[] = [];
  games.publish = async () => {
    throw new Error('offline');
  };
  await games.flushEvents();
  assert.equal((await games.current(ids[0]!))!.status, 'active');
  assert.ok(
    (await pool.query('SELECT count(*) FROM outbox WHERE published_at IS NULL AND attempts>0'))
      .rows[0].count > 0,
  );
  await pool.query('UPDATE outbox SET next_attempt_at=now() WHERE published_at IS NULL');
  const restarted = new GameService(pool);
  restarted.publish = async (event, recipients) => {
    published.push({ event, recipients });
  };
  // Drain the actual backlog left by preceding scenarios, regardless of suite size.
  const outstanding = Number(
    (await pool.query('SELECT count(*) FROM outbox WHERE published_at IS NULL')).rows[0].count,
  );
  for (let index = 0; index < Math.ceil(outstanding / 100); index++) await restarted.flushEvents();
  const found = published.find((value) => value.event.gameId === room.id);
  assert.ok(found);
  assert.ok(found.recipients.includes(ids[0]));
  assert.deepEqual(Object.keys(found.event).sort(), ['eventId', 'gameId', 'version']);
});
test('Socket.IO authorizes each command, isolates hands and restores a room on reconnect', async () => {
  const origin = 'http://localhost:5173';
  const config = readConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    JWT_SECRET: 'socket-game-test-secret-'.repeat(4),
    ALLOWED_ORIGINS: origin,
    LOG_LEVEL: 'silent',
    SERVE_WEB: 'false',
  });
  const app = createApplication(config, pool, {
    backgroundWork: false,
    now: () => now,
    random: (max) => max - 1,
  });
  await new Promise<void>((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.httpServer.address() as { port: number }).port}`;
  const sockets: ReturnType<typeof clientIO>[] = [];
  async function open(token: string) {
    const socket = clientIO(url, {
      autoConnect: false,
      transports: ['websocket'],
      auth: { token, protocolVersion: 1 },
      extraHeaders: { origin },
      reconnection: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('session:ready', () => resolve());
      socket.once('connect_error', reject);
      socket.connect();
    });
    return socket;
  }
  try {
    const a = await app.auth.guest({ displayName: 'Socket uno' }),
      b = await app.auth.guest({ displayName: 'Socket dos' }),
      c = await app.auth.guest({ displayName: 'Intruso' });
    const sa = await open(a.body.accessToken),
      sb = await open(b.body.accessToken),
      sc = await open(c.body.accessToken);
    const call = (s: typeof sa, cmd: unknown) => s.timeout(3000).emitWithAck('game:command', cmd);
    assert.equal(
      (
        await call(sa, {
          type: 'room:create',
          operationId: randomUUID(),
          name: 'Socket mesa',
          mode: 'classic',
          capacity: 2,
        })
      ).ok,
      true,
    );
    let view = (await sa.timeout(3000).emitWithAck('room:current', { requestId: randomUUID() }))
      .value;
    await call(sb, { type: 'room:join', operationId: randomUUID(), code: view.code });
    view = (await app.games.current(a.body.player.id))!;
    await call(sa, {
      type: 'room:start',
      operationId: randomUUID(),
      gameId: view.id,
      expectedVersion: view.version,
    });
    const va = (await sa.timeout(3000).emitWithAck('room:current', { requestId: randomUUID() }))
      .value;
    const vb = (await sb.timeout(3000).emitWithAck('room:current', { requestId: randomUUID() }))
      .value;
    assert.equal(va.hand.length, 10);
    assert.equal(vb.hand.length, 10);
    assert.ok(
      va.hand.every((card: any) => !vb.hand.some((other: any) => other.cardNo === card.cardNo)),
    );
    assert.equal(
      (await sc.timeout(3000).emitWithAck('room:current', { requestId: randomUUID() })).value,
      null,
    );
    assert.equal(
      (await call(sc, { type: 'turn:draw', ...base(va), source: 'stock' })).code,
      'NOT_A_MEMBER',
    );
    sa.disconnect();
    const again = await open(a.body.accessToken);
    const recovered = (
      await again.timeout(3000).emitWithAck('room:current', { requestId: randomUUID() })
    ).value;
    assert.deepEqual(recovered.hand, va.hand);
    assert.equal(recovered.round.deadlineAt, va.round.deadlineAt);
    await app.auth.logout(a.refreshToken);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(again.connected, false);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
  }
});
