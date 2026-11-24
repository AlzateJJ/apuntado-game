import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  GameCommand,
  RoomSnapshot,
} from '@apuntado/contracts';
import { createApplication } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { variantCatalog } from '../apps/server/src/game/rules/catalog.js';
import { bestEvaluation, handFromIds } from '../apps/server/src/game/rules/evaluation.js';
import { cards, shuffle } from '../apps/server/src/game/domain.js';
import { arrangeTable } from '../tests/helpers/arrange-table.js';
import { full433 } from '../tests/helpers/rules-fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('A dedicated _test database is required');
const schema = `load_${randomUUID().replaceAll('-', '')}`;
await runner({
  databaseUrl,
  schema,
  createSchema: true,
  dir: fileURLToPath(new URL('../database/migrations', import.meta.url)),
  direction: 'up',
  migrationsTable: 'schema_migrations',
  log: () => {},
});
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: 10,
  statement_timeout: 10000,
});
const commits = new Map<string, number>(),
  acknowledgements: number[] = [],
  notifications: number[] = [],
  evaluations: number[] = [],
  reads: number[] = [],
  rtts: number[] = [];
const errors: string[] = [],
  seen = new Set<string>();
let measuring = false,
  duplicates = 0,
  commands = 0,
  received = 0;
const config = readConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  JWT_SECRET: 'load-test-only-secret-'.repeat(4),
  ALLOWED_ORIGINS: 'http://127.0.0.1:3102',
  LOG_LEVEL: 'silent',
});
const application = createApplication(config, pool, {
  onCommitted: (receipt, at) => {
    if (measuring) commits.set(`${receipt.gameId}:${receipt.version}`, at);
  },
});
await new Promise<void>((resolve) => application.httpServer.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(application.httpServer.address() as { port: number }).port}`;
config.origins.push(url);
type Client = {
  id: string;
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  gameId: string;
};
const clients: Client[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function connect(token: string) {
  const socket: Client['socket'] = io(url, {
    transports: ['websocket'],
    auth: { token, protocolVersion: 1 },
    extraHeaders: { Origin: url },
    autoConnect: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('session:ready', () => resolve());
    socket.once('connect_error', reject);
    socket.connect();
  });
  return socket;
}
async function current(client: Client) {
  const start = performance.now();
  const result = await client.socket
    .timeout(5000)
    .emitWithAck('room:current', { requestId: randomUUID() });
  if (!result.ok) throw new Error(result.code);
  if (measuring) reads.push(performance.now() - start);
  if (result.value) {
    const serialized = JSON.stringify(result.value);
    assert.ok(!serialized.includes('owner_id'));
    for (const member of result.value.players) assert.equal('hand' in member, false);
    assert.equal(result.value.id, client.gameId);
  }
  return result.value!;
}
async function command(client: Client, input: GameCommand) {
  const started = performance.now();
  const result = await client.socket.timeout(8000).emitWithAck('game:command', input);
  if (!result.ok) throw new Error(`${input.type}: ${result.code}`);
  if (measuring) {
    acknowledgements.push(performance.now() - started);
    commands++;
  }
  return result.value;
}
const base = (room: RoomSnapshot) => ({
  operationId: randomUUID(),
  gameId: room.id,
  expectedVersion: room.version,
  roundNo: room.round!.number,
  turnNo: room.round!.turnNo,
});
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    Number((sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(3));
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: percentile(1),
  };
};
try {
  console.log('Preparing 10 rooms and 60 authenticated WebSocket clients…');
  // Identity provisioning is outside the measurement; do not bypass application command limits.
  for (let roomIndex = 0; roomIndex < 10; roomIndex++) {
    const roomClients: Client[] = [];
    for (let seat = 0; seat < 6; seat++) {
      const issued = await application.auth.guest({ displayName: `Load ${roomIndex}-${seat}` });
      const socket = await connect(issued.body.accessToken);
      const client = { id: issued.body.player.id, socket, gameId: '' };
      clients.push(client);
      roomClients.push(client);
    }
    const host = roomClients[0]!;
    const receipt = await command(host, {
      type: 'room:create',
      operationId: randomUUID(),
      name: `Load room ${roomIndex}`,
      mode: roomIndex % 2 ? 'apuntado' : 'classic',
      capacity: 6,
    });
    for (const client of roomClients) client.gameId = receipt.gameId;
    const waiting = await current(host);
    for (const client of roomClients.slice(1))
      await command(client, { type: 'room:join', operationId: randomUUID(), code: waiting.code });
    const ready = await current(host);
    await command(host, {
      type: 'room:start',
      operationId: randomUUID(),
      gameId: ready.id,
      expectedVersion: ready.version,
    });
  }
  // Drain setup notifications before attaching measured recipients.
  await application.games.flushEvents();
  for (const client of clients) {
    client.socket.on('game:changed', (event) => {
      if (event.gameId !== client.gameId) {
        errors.push('cross-room event');
        return;
      }
      if (!measuring) return;
      assert.deepEqual(Object.keys(event).sort(), ['eventId', 'gameId', 'version']);
      const start = commits.get(`${event.gameId}:${event.version}`);
      if (start === undefined) return;
      const key = `${client.id}:${event.eventId}`;
      if (seen.has(key)) duplicates++;
      else {
        seen.add(key);
        received++;
        notifications.push(performance.now() - start);
      }
      void current(client).catch((error) => errors.push(String(error)));
    });
    const start = performance.now();
    const pong = await client.socket
      .timeout(5000)
      .emitWithAck('session:ping', { requestId: randomUUID() });
    assert.ok(pong.ok);
    rtts.push(performance.now() - start);
  }
  // One monotonic process clock for server commit observation and all client receptions.
  measuring = true;
  const started = performance.now();
  console.log('Measuring 720 legal commands, two-second transitions and every recipient…');
  await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const group = clients.slice(index * 6, index * 6 + 6);
      for (let turn = 0; turn < 36; turn++) {
        let room = await current(group[0]!);
        const actor = group.find((c) => c.id === room.round!.turnPlayerId)!;
        await command(actor, { type: 'turn:draw', ...base(room), source: 'stock' });
        await delay(500);
        room = await current(actor);
        await command(actor, { type: 'turn:discard', ...base(room), cardNo: room.hand[0]!.cardNo });
        const priorTurn = room.round!.turnNo;
        await delay(2000);
        const transitionDeadline = Date.now() + 5000;
        do {
          room = await current(actor);
          if (room.round!.turnNo > priorTurn) break;
          await delay(100);
        } while (Date.now() < transitionDeadline);
        assert.equal(room.round!.turnNo, priorTurn + 1);
      }
    }),
  );
  await application.games.flushEvents();
  const receptionDeadline = Date.now() + 5000;
  while (received < commands * 6 && Date.now() < receptionDeadline) await delay(50);
  const duration = performance.now() - started;
  measuring = false;
  assert.equal(commands, 720);
  assert.equal(received, commands * 6);
  assert.deepEqual(errors, []);
  // Additional recovery/closure probes are deliberately excluded from the legal-command distribution.
  const recovered = clients[0]!;
  const before = await current(recovered);
  recovered.socket.disconnect();
  await new Promise<void>((resolve) => {
    recovered.socket.once('session:ready', () => resolve());
    recovered.socket.connect();
  });
  assert.deepEqual((await current(recovered)).hand, before.hand);
  let timeoutLateness = 0;
  const timed = await current(clients[6]!);
  const expires = Date.now() + 500;
  await pool.query(
    `UPDATE round SET turn_started_at=$2::timestamptz-interval '30 seconds',turn_deadline_at=$2 WHERE game_id=$1 AND status='open'`,
    [timed.id, new Date(expires)],
  );
  await delay(850);
  const expired = await current(clients[6]!);
  assert.equal(expired.round!.turnNo, timed.round!.turnNo + 1);
  timeoutLateness = Date.parse(expired.round!.startedAt) - expires;
  for (const group of [clients.slice(0, 6), clients.slice(6, 12)]) {
    const actor = group[0]!;
    const winning = full433(),
      second = full433(2),
      used = new Set([...winning, ...second]);
    const spare = cards()
      .map((card) => card.cardNo)
      .filter((id) => !used.has(id));
    const hands: Record<string, number[]> = { [actor.id]: winning, [group[1]!.id]: second };
    for (const client of group.slice(2)) hands[client.id] = spare.splice(0, 10);
    await arrangeTable(pool, actor.gameId, hands, actor.id);
    const room = await current(actor),
      start = performance.now();
    await command(actor, { type: 'round:close', ...base(room), closure: 'combinaciones' });
    assert.ok((await current(actor)).result);
    console.log(`${room.mode} settlement probe: ${(performance.now() - start).toFixed(1)} ms`);
  }
  const all = cards().map((card) => card.cardNo);
  for (let i = 0; i < 1000; i++) {
    const hand = handFromIds(shuffle(all, (max) => Math.floor(Math.random() * max)).slice(0, 10));
    const start = performance.now();
    bestEvaluation(hand);
    evaluations.push(performance.now() - start);
  }
  const closeEvaluations: number[] = [];
  const profile = {
    profile_id: 'apuntado-v2',
    mode: 'apuntado' as const,
    combination_reward: 10,
    suit_reward: 25,
    touch_max: 5,
    elimination_score: -101,
    victory_score: 51,
  };
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    variantCatalog(profile.profile_id)(
      [
        { id: 'a', hand: full433(), score: 0 },
        { id: 'b', hand: full433(2), score: 0 },
      ],
      'a',
      'combinaciones',
      profile,
    );
    closeEvaluations.push(performance.now() - start);
  }
  const report = {
    at: new Date().toISOString(),
    environment: {
      node: process.version,
      os: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()[0]?.model,
      rooms: 10,
      clients: 60,
      postgres: '18',
      network: 'loopback; server and clients share one monotonic clock',
      provisioning: 'direct auth service outside measurement',
      pacingMs: 500,
    },
    durationMs: Math.round(duration),
    commands,
    expectedRecipients: commands * 6,
    received,
    duplicates,
    errors,
    milliseconds: {
      ack: stats(acknowledgements),
      commitObservedToRecipient: stats(notifications),
      snapshot: stats(reads),
      pingRTT: stats(rtts),
      evaluation: stats(evaluations),
      settlement: stats(closeEvaluations),
    },
    probes: {
      reconnect: true,
      timeout: true,
      timeoutLatenessMs: timeoutLateness,
      classicClose: true,
      apuntadoClose: true,
    },
    limitations:
      'Local pilot, not Internet latency or real devices. Commit time is observed immediately after pg COMMIT resolves; sub-millisecond scheduling bias is not separately measured.',
    samples: {
      ack: acknowledgements,
      commitObservedToRecipient: notifications,
      snapshot: reads,
      pingRTT: rtts,
      evaluation: evaluations,
      settlement: closeEvaluations,
    },
  };
  await mkdir('.local', { recursive: true });
  await writeFile('.local/load-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
  assert.ok(stats(acknowledgements).p95 <= 500, 'ack p95 must be <=500 ms');
  assert.ok(stats(notifications).p95 <= 500, 'commit observed to recipient p95 must be <=500 ms');
  assert.ok(stats(evaluations).p95 <= 50, 'evaluation p95 must be <=50 ms');
} finally {
  for (const client of clients) client.socket.disconnect();
  await application.close();
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
}
