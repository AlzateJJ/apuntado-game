import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { io } from 'socket.io-client';

// This rehearsal is deliberately restricted to the separate preview Compose project.
const compose = ['compose', '-f', 'compose.preview.yaml'];
const url = 'http://localhost:3100';
function docker(args, { input, output } = {}) {
  const child = spawn('docker', [...compose, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let result = '',
    error = '';
  if (!output) child.stdout.on('data', (chunk) => (result += chunk));
  child.stderr.on('data', (chunk) => (error += chunk));
  const transfer = output
    ? pipeline(child.stdout, createWriteStream(output, { flags: 'wx' }))
    : Promise.resolve();
  if (input) createReadStream(input).pipe(child.stdin);
  else child.stdin.end();
  return Promise.all([
    transfer,
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Docker command failed: ${error}`)),
      );
    }),
  ]).then(() => result.trim());
}
const sql = (statement, database = 'apuntado_preview') =>
  docker([
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'preview',
    '-d',
    database,
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-t',
    '-A',
    '-c',
    statement,
  ]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await delay(200);
  }
  throw new Error('Rehearsal readiness timed out');
}
async function connect(session) {
  const socket = io(url, {
    transports: ['websocket'],
    auth: { token: session.accessToken, protocolVersion: 1 },
    extraHeaders: { Origin: url },
    autoConnect: false,
  });
  await new Promise((resolve, reject) => {
    socket.once('session:ready', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  return socket;
}
async function emit(socket, event, body) {
  const reply = await socket.timeout(5000).emitWithAck(event, body);
  if (!reply.ok) throw new Error(`${event}: ${reply.code}`);
  return reply.value;
}
const snapshot = (socket) => emit(socket, 'room:current', { requestId: randomUUID() });
const command = (socket, body) =>
  emit(socket, 'game:command', { operationId: randomUUID(), ...body });
const sockets = [];
const restoreName = `restore_${randomUUID().replaceAll('-', '')}`;
let restoreCreated = false;
await mkdir('.local/backups', { recursive: true });
const backup = `.local/backups/preview-${Date.now()}.dump`;
try {
  await until(async () => (await fetch(`${url}/api/ready`)).ok);
  const sessions = [];
  for (let index = 0; index < 2; index++) {
    const response = await fetch(`${url}/api/auth/guest`, {
      method: 'POST',
      headers: { Origin: url, 'X-Apuntado-Client': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: `Ensayo ${index + 1}` }),
    });
    assert.equal(response.status, 201);
    sessions.push(await response.json());
  }
  for (const session of sessions) sockets.push(await connect(session));
  const [host, guest] = sockets;
  const created = await command(host, {
    type: 'room:create',
    name: 'Ensayo de despliegue',
    mode: 'apuntado',
    capacity: 2,
  });
  const room = await snapshot(host);
  await command(guest, { type: 'room:join', code: room.code });
  const ready = await snapshot(host);
  await command(host, { type: 'room:start', gameId: ready.id, expectedVersion: ready.version });
  const before = await snapshot(host);
  const start = Date.now();
  await docker(['restart', 'app']);
  await until(() => host.connected && guest.connected);
  await until(async () => (await fetch(`${url}/api/ready`)).ok);
  const recovered = await snapshot(host);
  assert.deepEqual(recovered.hand, before.hand);
  assert.equal(recovered.round.deadlineAt, before.round.deadlineAt);
  assert.equal(recovered.version, before.version);
  console.log('Container restart retained session, cards, version and original deadline.');
  assert.match(created.gameId, /^[0-9a-f-]{36}$/);
  await sql(
    `UPDATE round SET turn_started_at=now()-interval '31 seconds',turn_deadline_at=now()-interval '1 second' WHERE game_id='${created.gameId}' AND status='open'`,
  );
  await until(async () => (await snapshot(host)).round.turnNo === before.round.turnNo + 1);
  // A known legal deal in the isolated rehearsal database makes settlement restoration reproducible.
  const first = [28, 29, 30, 31, 7, 20, 46, 9, 22, 48],
    second = first.map((id) => id + 52);
  const unused = Array.from({ length: 104 }, (_, i) => i + 1).filter(
    (id) => !first.includes(id) && !second.includes(id),
  );
  const positions = [];
  for (const [index, hand] of [first, second].entries()) {
    assert.match(sessions[index].player.id, /^[0-9a-f-]{36}$/);
    hand.forEach((id, ordinal) =>
      positions.push(
        `('${created.gameId}',1,${id},'hand','${sessions[index].player.id}',${ordinal})`,
      ),
    );
  }
  positions.push(`('${created.gameId}',1,${unused.pop()},'discard',NULL,0)`);
  unused.forEach((id, ordinal) =>
    positions.push(`('${created.gameId}',1,${id},'stock',NULL,${ordinal})`),
  );
  await sql(`BEGIN; SELECT game_id FROM game WHERE game_id='${created.gameId}' FOR UPDATE;
    DELETE FROM card_position WHERE game_id='${created.gameId}' AND round_no=1;
    INSERT INTO card_position(game_id,round_no,card_no,zone,owner_id,ordinal) VALUES ${positions.join(',')};
    UPDATE round SET phase='decision',turn_player_id='${sessions[0].player.id}',turn_started_at=now(),turn_deadline_at=now()+interval '30 seconds' WHERE game_id='${created.gameId}' AND round_no=1; COMMIT;`);
  const closing = await snapshot(host);
  await command(host, {
    type: 'round:close',
    gameId: closing.id,
    expectedVersion: closing.version,
    roundNo: 1,
    turnNo: closing.round.turnNo,
    closure: 'combinaciones',
  });
  const settled = await snapshot(host);
  assert.equal(settled.result.players.find((p) => p.id === sessions[0].player.id).delta, 10);
  await docker(['stop', 'app']);
  // Quiesce this rehearsal only, so dump comparisons are exact while preserving all rows.
  const digestQuery = `SELECT json_build_object('players',(SELECT count(*) FROM player),'games',(SELECT count(*) FROM game),'cards',(SELECT count(*) FROM card_position),'operations',(SELECT count(*) FROM processed_operation),'outbox',(SELECT count(*) FROM outbox),'scores',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY game_id,round_no,player_id)) FROM score_movement s),'evidence',(SELECT count(*) FROM evaluation_card),'rounds',(SELECT md5(string_agg(row_to_json(r)::text,'' ORDER BY game_id,round_no)) FROM round r))`;
  const sourceDigest = await sql(digestQuery);
  await docker(
    [
      'exec',
      '-T',
      'db',
      'pg_dump',
      '-U',
      'preview',
      '-d',
      'apuntado_preview',
      '-Fc',
      '--no-owner',
      '--no-privileges',
    ],
    { output: backup },
  );
  await sql(`CREATE DATABASE "${restoreName}"`, 'postgres');
  restoreCreated = true;
  await docker(
    [
      'exec',
      '-T',
      'db',
      'pg_restore',
      '-U',
      'preview',
      '-d',
      restoreName,
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
    ],
    { input: backup },
  );
  const restoredDigest = await sql(digestQuery, restoreName);
  assert.equal(restoredDigest, sourceDigest);
  const result = {
    at: new Date().toISOString(),
    url,
    restart: true,
    reconnected: true,
    preservedDeadline: true,
    preservedHand: true,
    expiredTurnAdvancedOnce: true,
    backup,
    restoreVerified: true,
    source: JSON.parse(sourceDigest),
    elapsedMs: Date.now() - start,
  };
  await writeFile('.local/operations-results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  sockets.forEach((socket) => socket.disconnect());
  if (restoreCreated) await sql(`DROP DATABASE "${restoreName}"`, 'postgres');
  await docker(['start', 'app']);
  await until(async () => (await fetch(`${url}/api/ready`)).ok);
}
