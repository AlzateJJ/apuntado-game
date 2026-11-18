import { test, expect } from './fixtures.js';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Page, BrowserContext } from '@playwright/test';

async function guest(page: Page, name: string, url = '/') {
  await page.goto(url);
  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByLabel('Tu nombre en la mesa').fill(name);
  await page.getByRole('button', { name: 'Entrar como invitado', exact: true }).click();
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crear sala', exact: false })).toBeVisible();
}
async function create(page: Page, mode: 'Clásica' | 'Apuntado' = 'Apuntado', capacity = '2') {
  await page.getByLabel('Nombre de la sala').fill('Mesa del encuentro');
  await page.getByRole('radio', { name: new RegExp(mode) }).check();
  await page.getByLabel('Número máximo de jugadores').selectOption(capacity);
  await page.getByRole('button', { name: 'Crear sala', exact: false }).click();
  await expect(page.getByTestId('room-code')).toBeVisible();
  return (await page.getByTestId('room-code').innerText()).trim();
}
async function join(page: Page, code: string) {
  await page.getByLabel('Código de la sala').fill(code);
  await page.getByRole('button', { name: 'Unirme a la sala' }).click();
}

test('two isolated players choose a mode, deal, play a turn and recover their private hands', async ({
  page,
  browser,
  harness,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const extra: BrowserContext = await browser.newContext(info.project.use);
  const other = await extra.newPage();
  other.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
    await page.getByLabel('Tu nombre en la mesa').fill('Anfitrión');
    await page.getByLabel('Correo electrónico').fill(`host-${randomUUID()}@example.com`);
    await page.getByLabel('Contraseña', { exact: true }).fill('una cuenta para la mesa');
    await page.getByRole('button', { name: 'Crear mi cuenta' }).click();
    await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
    const mode = info.project.name === 'desktop' ? 'Clásica' : 'Apuntado';
    const code = await create(page, mode);
    await expect(page.getByRole('button', { name: 'Repartir y empezar' })).toBeDisabled();
    await guest(other, 'Compañera', harness.url);
    await join(other, code);
    await expect(
      page.getByRole('list', { name: 'Jugadores en la sala' }).getByRole('listitem'),
    ).toHaveCount(2);
    await page.getByRole('button', { name: 'Repartir y empezar' }).click();
    await expect(page.getByRole('group', { name: 'Tu mano' }).getByRole('button')).toHaveCount(10);
    await expect(other.getByRole('group', { name: 'Tu mano' }).getByRole('button')).toHaveCount(10);
    await expect(
      page.getByText(`MODALIDAD ${mode === 'Clásica' ? 'CLÁSICA' : 'APUNTADO'}`, { exact: false }),
    ).toBeVisible();
    const actor = (await page.getByRole('heading', { name: 'Es tu turno', exact: true }).count())
      ? page
      : other;
    const spectator = actor === page ? other : page;
    await expect(spectator.getByRole('button', { name: 'Robar del mazo' })).toBeDisabled();
    const before = await actor
      .getByRole('group', { name: 'Tu mano' })
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
    await actor.reload();
    await expect(actor.getByText('Conexión activa', { exact: true })).toBeVisible();
    await expect(actor.getByRole('group', { name: 'Tu mano' }).getByRole('button')).toHaveCount(10);
    expect(
      await actor
        .getByRole('group', { name: 'Tu mano' })
        .getByRole('button')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    ).toEqual(before);
    await actor.getByRole('button', { name: 'Robar del mazo' }).click();
    await expect(actor.getByRole('group', { name: 'Tu mano' }).getByRole('button')).toHaveCount(11);
    await actor.getByRole('group', { name: 'Tu mano' }).getByRole('button').first().click();
    await actor.getByRole('button', { name: 'Descartar carta seleccionada' }).click();
    await expect(actor.getByRole('group', { name: 'Tu mano' }).getByRole('button')).toHaveCount(10);
    await actor.getByRole('button', { name: 'Terminar turno' }).click();
    await expect(
      spectator.getByRole('heading', { name: 'Es tu turno', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('TURNO 2', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await mkdir('.local', { recursive: true });
    await page.screenshot({ path: `.local/table-${info.project.name}.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await extra.close();
  }
});

test('a full room rejects an extra player and the host can transfer ownership by leaving', async ({
  page,
  browser,
  harness,
}, info) => {
  const second = await browser.newContext(info.project.use),
    third = await browser.newContext(info.project.use);
  try {
    const b = await second.newPage(),
      c = await third.newPage();
    await guest(page, 'Dueña de sala');
    const code = await create(page);
    await guest(b, 'Nuevo anfitrión', harness.url);
    await join(b, code);
    await expect(page.getByRole('button', { name: 'Repartir y empezar' })).toBeEnabled();
    await guest(c, 'Tercer jugador', harness.url);
    await join(c, code);
    await expect(c.getByRole('alert')).toContainText('llena');
    await page.getByRole('button', { name: 'Salir de la sala' }).click();
    await expect(page.getByRole('button', { name: 'Crear sala', exact: false })).toBeVisible();
    await expect(b.getByRole('button', { name: 'Repartir y empezar' })).toBeVisible();
    await join(c, code);
    await expect(b.getByRole('button', { name: 'Repartir y empezar' })).toBeEnabled();
    await expect(
      b.getByRole('list', { name: 'Jugadores en la sala' }).getByRole('listitem'),
    ).toHaveCount(2);
    await b.getByRole('button', { name: 'Repartir y empezar' }).click();
    await expect(c.getByRole('group', { name: 'Tu mano' }).getByRole('button')).toHaveCount(10);
  } finally {
    await second.close();
    await third.close();
  }
});

test('a lost acknowledgement retries the original operation without creating a second room', async ({
  page,
  harness,
}) => {
  const name = `Reintento ${randomUUID().slice(0, 6)}`;
  await guest(page, name);
  const socket = Array.from(harness.application.io.sockets.sockets.values()).find(
    (value) => value.data.identity.player.displayName === name,
  )!;
  const handler = socket.listeners('game:command')[0]!;
  socket.removeAllListeners('game:command');
  let drop = true;
  socket.on('game:command', (command, ack) => {
    Reflect.apply(handler, socket, [
      command,
      (reply: unknown) => {
        if (drop) {
          drop = false;
          return;
        }
        ack(reply as never);
      },
    ]);
  });
  await create(page);
  await expect(page.getByRole('button', { name: 'Reintentar la misma acción' })).toBeVisible({
    timeout: 9000,
  });
  await page.getByRole('button', { name: 'Reintentar la misma acción' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const result = await harness.pool.query('SELECT count(*) FROM game WHERE host_player_id=$1', [
    socket.data.identity.player.id,
  ]);
  expect(result.rows[0].count).toBe('1');
});

test('the running scheduler completes a disconnected player turn after thirty real seconds', async ({
  page,
  browser,
  harness,
}, info) => {
  test.setTimeout(60000);
  const extra = await browser.newContext(info.project.use);
  const other = await extra.newPage();
  try {
    await guest(page, 'Reloj uno');
    const code = await create(page);
    await guest(other, 'Reloj dos', harness.url);
    await join(other, code);
    await expect(page.getByRole('button', { name: 'Repartir y empezar' })).toBeEnabled();
    await page.getByRole('button', { name: 'Repartir y empezar' }).click();
    await expect(page.getByRole('group', { name: 'Tu mano' }).getByRole('button')).toHaveCount(10);
    const row = (
      await harness.pool.query(
        'SELECT g.game_id,r.turn_deadline_at,r.turn_started_at,r.turn_player_id FROM game g JOIN round r USING(game_id) WHERE g.join_code=$1',
        [code],
      )
    ).rows[0];
    expect(row.turn_deadline_at.getTime() - row.turn_started_at.getTime()).toBe(30000);
    const actor = (await page.getByRole('heading', { name: 'Es tu turno', exact: true }).count())
      ? page
      : other;
    const observer = actor === page ? other : page;
    await actor.close();
    // One real-time run plus a fast mobile scheduler run, without a public clock-control endpoint.
    if (info.project.name === 'mobile')
      await harness.pool.query(
        "UPDATE round SET turn_started_at=now()-interval '31 seconds',turn_deadline_at=now()-interval '1 second' WHERE game_id=$1",
        [row.game_id],
      );
    await expect(observer.getByText('TURNO 2', { exact: true })).toBeVisible({ timeout: 35000 });
    if (info.project.name === 'desktop')
      expect(Date.now()).toBeGreaterThanOrEqual(row.turn_deadline_at.getTime());
    await expect(observer.getByText('agotó el tiempo', { exact: false })).toBeVisible();
    const state = (
      await harness.pool.query('SELECT last_action FROM game WHERE game_id=$1', [row.game_id])
    ).rows[0];
    expect(state.last_action.automatic).toBe(true);
    const count = (
      await harness.pool.query(
        "SELECT count(*) FROM card_position WHERE game_id=$1 AND owner_id=$2 AND zone='hand'",
        [row.game_id, row.turn_player_id],
      )
    ).rows[0].count;
    expect(count).toBe('10');
  } finally {
    await extra.close();
  }
});
