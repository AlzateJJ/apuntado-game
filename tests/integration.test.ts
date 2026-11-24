import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Pool } from 'pg';
import request from 'supertest';
import { io as clientIO, type Socket } from 'socket.io-client';
import { SignJWT } from 'jose';
import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('TEST_DATABASE_URL debe apuntar a una base con nombre terminado en _test.');
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: databaseUrl });
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  connectionTimeoutMillis: 5000,
});
const origin = 'http://localhost:5173';
const secret = 'integration-tests-secret-not-for-production-'.repeat(2);
const config = readConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  JWT_SECRET: secret,
  ALLOWED_ORIGINS: origin,
  LOG_LEVEL: 'silent',
  SERVE_WEB: 'false',
});
const application = createApplication(config, pool);
let url: string;
const post = (path: string, body: unknown = {}, cookie?: string) => {
  const call = request(application.app)
    .post(`/api/auth/${path}`)
    .set('Origin', origin)
    .set('X-Apuntado-Client', '1');
  if (cookie) call.set('Cookie', cookie);
  return call.send(body);
};
const cookieOf = (response: request.Response) =>
  (response.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
const connect = (token: string, protocolVersion = 1, connectionOrigin = origin) =>
  clientIO(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { token, protocolVersion },
    extraHeaders: { origin: connectionOrigin },
    timeout: 2000,
    autoConnect: false,
  });
const waitReady = (socket: Socket) =>
  new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket timeout'));
    }, 4000);
    socket.once('session:ready', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.connect();
  });
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
  await new Promise<void>((resolve) => application.httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(application.httpServer.address() as { port: number }).port}`;
});
after(async () => {
  await application.close();
  await pool.end();
  if (!/^test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

test('migrations are repeatable and preserve academic profiles with new 30-second rules', async () => {
  const applied = await runner({
    databaseUrl,
    schema,
    dir: fileURLToPath(new URL('../database/migrations', import.meta.url)),
    direction: 'up',
    migrationsTable: 'schema_migrations',
    log: () => {},
  });
  assert.equal(applied.length, 0);
  const profiles = (await pool.query('SELECT * FROM rule_profile ORDER BY profile_id')).rows;
  assert.equal(profiles.length, 4);
  assert.equal(profiles.find((row) => row.profile_id === 'apuntado-v2').turn_seconds, 30);
  assert.equal(profiles.find((row) => row.profile_id === 'classic-v1').turn_seconds, null);
  await assert.rejects(
    pool.query("UPDATE rule_profile SET turn_seconds=40 WHERE profile_id='apuntado-v2'"),
    /inmutable/,
  );
  await assert.rejects(
    pool.query("DELETE FROM rule_profile WHERE profile_id='apuntado-v2'"),
    /inmutable/,
  );
});
test('health and readiness use the running database', async () => {
  assert.equal((await request(application.app).get('/api/health')).status, 200);
  assert.equal((await request(application.app).get('/api/ready')).status, 200);
});
test('account registration normalizes email, hashes password, and returns a private cookie', async () => {
  const response = await post('register', {
    displayName: '  Ana  ',
    email: '  ANA@example.com ',
    password: 'mi frase de acceso 123',
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.player.displayName, 'Ana');
  assert.equal(response.body.player.kind, 'account');
  assert.deepEqual(response.body.account, { email: 'ana@example.com' });
  assert.equal('email' in response.body.player, false);
  assert.match(response.headers['set-cookie'][0], /HttpOnly/);
  assert.match(response.headers['set-cookie'][0], /SameSite=Lax/);
  assert.equal(response.headers['cache-control'], 'no-store');
  const account = (
    await pool.query("SELECT * FROM account WHERE email_normalized='ana@example.com'")
  ).rows[0];
  assert.match(account.password_hash, /^\$argon2id\$/);
  assert.ok(!JSON.stringify(response.body).includes('password_hash'));
  const session = (
    await pool.query('SELECT * FROM auth_session WHERE player_id=$1', [response.body.player.id])
  ).rows[0];
  assert.match(session.refresh_token_hash, /^[a-f0-9]{64}$/);
  assert.ok(!cookieOf(response).includes(session.refresh_token_hash));
  const me = await request(application.app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${response.body.accessToken}`);
  assert.deepEqual(me.body.player, response.body.player);
  assert.ok(!JSON.stringify(me.body).includes('ana@example.com'));
  const socket = connect(response.body.accessToken);
  try {
    const ready = await waitReady(socket);
    assert.ok(!JSON.stringify(ready).includes('ana@example.com'));
  } finally {
    socket.disconnect();
  }
  const renewed = await post('refresh', {}, cookieOf(response));
  assert.deepEqual(renewed.body.account, { email: 'ana@example.com' });
});
test('duplicate email rolls back the extra player and login rejects invalid credentials', async () => {
  const beforeCount = (await pool.query('SELECT count(*) FROM player')).rows[0].count;
  assert.equal(
    (
      await post('register', {
        displayName: 'Ana 2',
        email: 'ANA@example.com',
        password: 'otra frase segura 123',
      })
    ).status,
    409,
  );
  assert.equal((await pool.query('SELECT count(*) FROM player')).rows[0].count, beforeCount);
  const wrong = await post('login', { email: 'ana@example.com', password: 'incorrecta' });
  const unknown = await post('login', { email: 'nadie@example.com', password: 'incorrecta' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  const good = await post('login', {
    email: 'ANA@example.com',
    password: 'mi frase de acceso 123',
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.player.kind, 'account');
  assert.deepEqual(good.body.account, { email: 'ana@example.com' });
});
test('validation and CSRF protections reject forged or malformed requests', async () => {
  assert.equal((await post('guest', { displayName: 'X' })).status, 400);
  assert.equal((await post('guest', { displayName: 'Valid', playerId: randomUUID() })).status, 400);
  assert.equal(
    (await post('register', { displayName: 'Juan', email: 'x@example.com', password: 'short' }))
      .status,
    400,
  );
  assert.equal(
    (await request(application.app).post('/api/auth/guest').send({ displayName: 'Intruso' }))
      .status,
    403,
  );
  assert.equal(
    (
      await request(application.app)
        .post('/api/auth/guest')
        .set('Origin', 'https://evil.example')
        .set('X-Apuntado-Client', '1')
        .send({ displayName: 'Intruso' })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(application.app)
        .post('/api/auth/guest')
        .set('Origin', origin)
        .set('X-Apuntado-Client', '1')
        .set('Content-Type', 'application/json')
        .send('{bad')
    ).status,
    400,
  );
  assert.equal((await post('guest', { displayName: 'x'.repeat(10000) })).status, 413);
});
test('guests persist through refresh and server recreation without creating accounts', async () => {
  const guest = await post('guest', { displayName: 'Visita' });
  assert.equal(guest.status, 201);
  assert.equal(guest.body.player.kind, 'guest');
  assert.equal(guest.body.account, null);
  assert.equal(
    (await pool.query('SELECT count(*) FROM account WHERE player_id=$1', [guest.body.player.id]))
      .rows[0].count,
    '0',
  );
  const renewed = await post('refresh', {}, cookieOf(guest));
  assert.equal(renewed.status, 200);
  assert.deepEqual(renewed.body.player, guest.body.player);
  assert.equal(renewed.body.account, null);
  assert.notEqual(cookieOf(renewed), cookieOf(guest));
  const restarted = createApplication(config, pool);
  try {
    assert.deepEqual(
      (await restarted.auth.authenticate(renewed.body.accessToken)).player,
      guest.body.player,
    );
  } finally {
    await restarted.close();
  }
});
test('concurrent refresh has one winner and does not revoke the session', async () => {
  const guest = await post('guest', { displayName: 'Concurrente' });
  const cookie = cookieOf(guest);
  const attempts = await Promise.all([post('refresh', {}, cookie), post('refresh', {}, cookie)]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const winner = attempts.find((r) => r.status === 200)!;
  assert.equal((await post('refresh', {}, cookieOf(winner))).status, 200);
});
test('replay of previous refresh after grace revokes the session', async () => {
  const guest = await post('guest', { displayName: 'Replay' });
  const first = cookieOf(guest);
  const renewed = await post('refresh', {}, first);
  await pool.query(
    "UPDATE auth_session SET rotated_at=now()-interval '20 seconds' WHERE player_id=$1",
    [guest.body.player.id],
  );
  assert.equal((await post('refresh', {}, first)).status, 401);
  assert.equal((await post('refresh', {}, cookieOf(renewed))).status, 401);
  assert.equal(
    (
      await request(application.app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${renewed.body.accessToken}`)
    ).status,
    401,
  );
});
test('authenticated Socket.IO uses only websocket and validates acknowledgements', async () => {
  const guest = await post('guest', { displayName: 'Conectada' });
  const socket = connect(guest.body.accessToken);
  try {
    const ready = await waitReady(socket);
    assert.deepEqual(ready.player, guest.body.player);
    assert.equal(ready.protocolVersion, 1);
    assert.equal(socket.io.engine.transport.name, 'websocket');
    const requestId = randomUUID();
    const result = await socket.timeout(2000).emitWithAck('session:ping', { requestId });
    assert.equal(result.ok, true);
    assert.equal(result.requestId, requestId);
    assert.deepEqual(
      await socket.timeout(2000).emitWithAck('session:ping', { requestId: 'invalid' }),
      { ok: false, code: 'INVALID_COMMAND' },
    );
    assert.equal((await request(url).get('/socket.io/?EIO=4&transport=polling')).status, 400);
  } finally {
    socket.disconnect();
  }
});
test('Socket.IO rejects missing token, wrong protocol, and foreign origin', async () => {
  const guest = await post('guest', { displayName: 'Socket checks' });
  for (const socket of [
    connect(''),
    connect('fake'),
    connect(guest.body.accessToken, 2),
    connect(guest.body.accessToken, 1, 'https://evil.example'),
  ]) {
    try {
      await assert.rejects(waitReady(socket));
    } finally {
      socket.disconnect();
    }
  }
});
test('logout revokes HTTP access and all sockets for that session only', async () => {
  const guest = await post('guest', { displayName: 'Salida' });
  const other = await post('guest', { displayName: 'Se queda' });
  const sockets = [
    connect(guest.body.accessToken),
    connect(guest.body.accessToken),
    connect(other.body.accessToken),
  ];
  try {
    await Promise.all(sockets.map(waitReady));
    const revoked = sockets.slice(0, 2).map((s) => once(s, 'session:revoked'));
    assert.equal((await post('logout', {}, cookieOf(guest))).status, 204);
    await Promise.all(revoked);
    assert.equal(
      (
        await request(application.app)
          .get('/api/auth/me')
          .set('Authorization', `Bearer ${guest.body.accessToken}`)
      ).status,
      401,
    );
    assert.equal((await post('refresh', {}, cookieOf(guest))).status, 401);
    assert.equal(
      (await sockets[2]!.timeout(2000).emitWithAck('session:ping', { requestId: randomUUID() })).ok,
      true,
    );
  } finally {
    sockets.forEach((s) => s.disconnect());
  }
});
test('token expiry actively disconnects an already connected socket', async () => {
  const guest = await post('guest', { displayName: 'Caduca' });
  const claims = await application.auth.authenticate(guest.body.accessToken);
  const shortToken = await new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.player.id)
    .setIssuer('apuntado')
    .setAudience('apuntado-web')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 2)
    .sign(new TextEncoder().encode(secret));
  const socket = connect(shortToken);
  try {
    await waitReady(socket);
    const expired = once(socket, 'session:expired');
    const disconnected = once(socket, 'disconnect');
    await expired;
    await disconnected;
    assert.equal(socket.connected, false);
  } finally {
    socket.disconnect();
  }
});
test('revoked session is rechecked for socket commands even without local notification', async () => {
  const guest = await post('guest', { displayName: 'Revocada' });
  const socket = connect(guest.body.accessToken);
  try {
    await waitReady(socket);
    await pool.query('UPDATE auth_session SET revoked_at=now() WHERE player_id=$1', [
      guest.body.player.id,
    ]);
    const result = await socket
      .timeout(2000)
      .emitWithAck('session:ping', { requestId: randomUUID() });
    assert.equal(result.code, 'SESSION_INVALID');
  } finally {
    socket.disconnect();
  }
});
test('production cookies are Secure and secrets/origins are validated', async () => {
  const production = createApplication({ ...config, production: true }, pool);
  try {
    const response = await request(production.app)
      .post('/api/auth/guest')
      .set('Origin', origin)
      .set('X-Apuntado-Client', '1')
      .send({ displayName: 'Producción' });
    assert.match(response.headers['set-cookie'][0], /^__Secure-apuntado_refresh=/);
    assert.match(response.headers['set-cookie'][0], /; Secure/);
  } finally {
    await production.close();
  }
  assert.throws(() =>
    readConfig({
      ...process.env,
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'short',
      ALLOWED_ORIGINS: origin,
    }),
  );
  assert.throws(() =>
    readConfig({
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      JWT_SECRET: secret,
      ALLOWED_ORIGINS: origin,
    }),
  );
});
test('database rejects invalid hand owners and active seat collisions', async () => {
  const g = randomUUID(),
    p = randomUUID(),
    q = randomUUID();
  await pool.query('INSERT INTO player(player_id,display_name) VALUES($1,$2),($3,$4)', [
    p,
    'Uno',
    q,
    'Dos',
  ]);
  await pool.query(
    "INSERT INTO game(game_id,profile_id,status) VALUES($1,'apuntado-v2','waiting')",
    [g],
  );
  await pool.query('INSERT INTO participation(game_id,player_id,seat) VALUES($1,$2,1)', [g, p]);
  await assert.rejects(
    pool.query('INSERT INTO participation(game_id,player_id,seat) VALUES($1,$2,1)', [g, q]),
    { code: '23505' },
  );
  await pool.query('UPDATE participation SET left_at=now() WHERE game_id=$1 AND player_id=$2', [
    g,
    p,
  ]);
  await pool.query('INSERT INTO participation(game_id,player_id,seat) VALUES($1,$2,1)', [g, q]);
  await assert.rejects(
    pool.query(
      "INSERT INTO round(game_id,round_no,status,phase,turn_player_id,initial_player_id) VALUES($1,1,'open','draw',$2,$2)",
      [g, p],
    ),
    { code: '23503' },
  );
});
test('auth attempts are rate limited', async () => {
  let last;
  for (let index = 0; index < 45; index++) last = await post('guest', { displayName: 'x' });
  assert.equal(last!.status, 429);
  assert.ok(last!.headers['retry-after']);
});
