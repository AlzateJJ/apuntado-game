import { test, expect, navigate, openNavigation, openAccount } from './fixtures.js';
import type { Page, BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

async function guest(page: Page, name: string, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByLabel('Tu nombre en la mesa').fill(name);
  await page.getByRole('button', { name: 'Entrar como invitado', exact: true }).click();
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
}
async function create(page: Page) {
  await page.getByRole('radio', { name: '3 jugadores', exact: true }).check();
  await page.getByRole('button', { name: 'Crear sala' }).click();
  return page.getByTestId('room-code').innerText();
}
async function join(page: Page, code: string) {
  await page.getByLabel('Código de la sala').fill(code);
  await page.getByRole('button', { name: 'Unirme a la sala' }).click();
}
const hand = (page: Page) => page.getByRole('group', { name: 'Tu mano' });
const order = (page: Page) =>
  hand(page)
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((button) => Number((button as HTMLElement).dataset.cardNo)),
    );

test('audio unlocks on interaction, alerts only the owner in the last seven seconds, and mutes completely', async ({
  page,
  harness,
}) => {
  test.setTimeout(45000);
  await page.addInitScript(() => {
    const original = window.AudioContext;
    const probe = {
      contexts: [] as AudioContext[],
      starts: [] as { hz: number; remaining: number; myTurn: boolean }[],
    };
    (window as unknown as { soundProbe: typeof probe }).soundProbe = probe;
    window.AudioContext = class extends original {
      constructor() {
        super();
        probe.contexts.push(this);
      }
      createOscillator() {
        const oscillator = super.createOscillator(),
          start = oscillator.start.bind(oscillator);
        const frequency = oscillator.frequency.setValueAtTime.bind(oscillator.frequency);
        let hz = 440;
        oscillator.frequency.setValueAtTime = (value: number, time: number) => {
          hz = value;
          return frequency(value, time);
        };
        oscillator.start = (when?: number) => {
          probe.starts.push({
            hz,
            remaining: Number(
              document.querySelector('[data-testid="turn-clock"] b')?.textContent ?? 30,
            ),
            myTurn: document.querySelector('.turn-heading h2')?.textContent === 'Es tu turno',
          });
          start(when);
        };
        return oscillator;
      }
    };
  });
  await page.goto('/');
  expect(await page.evaluate(() => (window as any).soundProbe.contexts.length)).toBe(0);
  await guest(page, 'Oyente', harness.url);
  await expect
    .poll(() => page.evaluate(() => (window as any).soundProbe.starts.length))
    .toBeGreaterThan(0);
  const code = await create(page);
  const extra = await harness.application.auth.guest({ displayName: 'Oyente dos' });
  await harness.application.games.execute(extra.body.player.id, {
    type: 'room:join',
    operationId: randomUUID(),
    code,
  });
  await harness.application.games.flushEvents();
  await expect(page.getByRole('button', { name: 'Repartir y empezar' })).toBeEnabled();
  await page.getByRole('button', { name: 'Repartir y empezar' }).click();
  await expect(hand(page).getByRole('button')).toHaveCount(10);
  const game = (await harness.pool.query('SELECT * FROM game WHERE join_code=$1', [code])).rows[0];
  await harness.pool.query(
    "UPDATE round SET turn_player_id=$2,turn_started_at=now(),turn_deadline_at=now()+interval '9 seconds' WHERE game_id=$1 AND status='open'",
    [game.game_id, game.host_player_id],
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Es tu turno', exact: true })).toBeVisible();
  await page.getByRole('heading', { name: 'Es tu turno', exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).soundProbe.starts.filter((s: any) => s.hz === 950 || s.hz === 1250)
              .length,
        ),
      { timeout: 11000 },
    )
    .toBeGreaterThanOrEqual(6);
  const ticks = await page.evaluate(() =>
    (window as any).soundProbe.starts.filter((s: any) => s.hz === 950 || s.hz === 1250),
  );
  expect(
    ticks.every((tick: any) => tick.myTurn && tick.remaining >= 1 && tick.remaining <= 7),
  ).toBe(true);
  await page.locator('.table-sound').getByRole('button', { name: 'Silenciar sonido' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).soundProbe.contexts.at(-1).state))
    .toBe('suspended');
  const count = await page.evaluate(() => (window as any).soundProbe.starts.length);
  await expect(page.getByRole('heading', { name: 'Turno de Oyente dos', exact: true })).toBeVisible(
    { timeout: 10000 },
  );
  expect(await page.evaluate(() => (window as any).soundProbe.starts.length)).toBe(count);
  await page.locator('.table-sound').getByRole('button', { name: 'Activar sonido' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).soundProbe.starts.length))
    .toBeGreaterThan(count);
  // An opponent near timeout must not trigger our alert.
  await harness.pool.query(
    "UPDATE round SET turn_started_at=now(),turn_deadline_at=now()+interval '4 seconds' WHERE game_id=$1 AND status='open'",
    [game.game_id],
  );
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Turno de Oyente dos', exact: true }),
  ).toBeVisible();
  await page.getByRole('heading', { name: 'Turno de Oyente dos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Es tu turno', exact: true })).toBeVisible({
    timeout: 7000,
  });
  expect(
    await page.evaluate(() =>
      (window as any).soundProbe.starts.filter((s: any) => s.hz === 950 || s.hz === 1250),
    ),
  ).toEqual([]);
});
async function play(page: Page) {
  await expect(page.getByRole('heading', { name: 'Es tu turno', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Robar del mazo', exact: true }).click();
  await expect(hand(page).getByRole('button')).toHaveCount(11);
  await hand(page).getByRole('button').last().click();
  await page.getByRole('button', { name: 'Descartar carta seleccionada' }).click();
  await expect(hand(page).getByRole('button')).toHaveCount(10);
}
async function drag(page: Page, context: BrowserContext, mobile: boolean) {
  const buttons = hand(page).getByRole('button');
  await buttons.first().scrollIntoViewIfNeeded();
  const a = (await buttons.first().boundingBox())!,
    b = (await buttons.nth(2).boundingBox())!;
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const end = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  if (mobile) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...start, id: 1 }],
    });
    for (let i = 1; i <= 8; i++)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: start.x + ((end.x - start.x) * i) / 8,
            y: start.y + ((end.y - start.y) * i) / 8,
            id: 1,
          },
        ],
      });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.mouse.up();
  }
}

test('sidebar, pointer sorting, retained order, two-second turns and read-only discard gallery', async ({
  page,
  context,
  browser,
  harness,
}, info) => {
  test.setTimeout(70000);
  const extra = await browser.newContext(info.project.use),
    other = await extra.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await guest(page, 'Anfitrión experiencia', harness.url);
    await navigate(page, 'Cómo jugar');
    await expect(page.getByRole('heading', { name: 'Cómo jugar.' })).toBeVisible();
    await navigate(page, 'Mi mesa');
    const code = await create(page);
    await guest(other, 'Compañero experiencia', harness.url);
    await join(other, code);
    await expect(page.getByRole('button', { name: 'Repartir y empezar' })).toBeEnabled();
    await page.getByRole('button', { name: 'Repartir y empezar' }).click();
    await expect(hand(page).getByRole('button')).toHaveCount(10);
    await expect(page.getByTestId('room-code')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Orden de reparto' })).toHaveCount(0);
    const actor = (await page.getByRole('heading', { name: 'Es tu turno', exact: true }).count())
      ? page
      : other;
    const observer = actor === page ? other : page;
    await expect(observer.locator('.felt')).toHaveClass(/felt-waiting/);
    await expect(actor.locator('.felt')).not.toHaveClass(/felt-waiting/);
    const before = await order(page);
    await drag(page, context, info.project.name === 'mobile');
    const expected = [...before];
    expected.splice(0, 1);
    expected.splice(2, 0, before[0]!);
    await expect.poll(() => order(page)).toEqual(expected);
    await page.reload();
    await expect.poll(() => order(page)).toEqual(expected);
    await page.getByRole('button', { name: 'Ordenar de menor a mayor' }).click();
    const ranked = await order(page);
    const ranks = ranked.map((id) => ((id - 1) % 13) + 1);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    await page.getByRole('button', { name: 'Ordenar por palo', exact: true }).click();
    const sorted = await order(page);
    const suits = sorted.map((id) => Math.floor(((id - 1) % 52) / 13));
    expect(suits).toEqual([...suits].sort((a, b) => a - b));
    // Reorder with the keyboard, then both participants take two full turns.
    await hand(page).getByRole('button').first().focus();
    await page.keyboard.press('Alt+ArrowRight');
    const stable = await order(page);
    for (let turn = 0; turn < 4; turn++) {
      const current = turn % 2 === 0 ? actor : observer;
      await play(current);
      await expect(
        current.getByText('El turno avanza automáticamente', { exact: false }),
      ).toBeVisible();
      const next = current === actor ? observer : actor;
      await expect(next.getByRole('button', { name: 'Robar del mazo', exact: true })).toBeEnabled();
      expect(await order(page)).toEqual(stable);
    }
    await page.reload();
    await expect.poll(() => order(page)).toEqual(stable);
    await expect(page.locator('.stack-layer')).toHaveCount(3);
    await page.getByRole('button', { name: 'Ver cartas descartadas' }).click();
    const modal = page.getByRole('dialog', { name: 'Pila de descarte' });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('listitem')).toHaveCount(5);
    await expect(modal.getByRole('button', { name: 'Robar del descarte' })).toHaveCount(0);
    expect(
      await modal.evaluate((element) => getComputedStyle(element, '::backdrop').backdropFilter),
    ).toBe('blur(6px)');
    await mkdir('.local', { recursive: true });
    await page.screenshot({ path: `.local/discard-${info.project.name}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Cerrar descarte' }).click();
    await expect(modal).not.toBeVisible();
    const sound = page.locator('.table-sound');
    await sound.getByRole('button', { name: 'Silenciar sonido' }).click();
    await page.reload();
    await expect(sound.getByRole('button', { name: 'Activar sonido' })).toBeVisible();
    await page.screenshot({ path: `.local/experience-${info.project.name}.png`, fullPage: true });
    if (info.project.name === 'mobile') {
      await openNavigation(page);
      await expect(page.getByRole('dialog', { name: 'Menú de Apuntado' })).toBeVisible();
      await page.screenshot({ path: '.local/sidebar-mobile.png', fullPage: true });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Abrir menú' })).toBeFocused();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    // A discarded physical card that returns later must append, not regain a stale saved slot.
    await actor.getByRole('button', { name: 'Ordenar por palo', exact: true }).click();
    const kept = await order(actor),
      returning = kept[0]!;
    await actor.getByRole('button', { name: 'Robar del mazo', exact: true }).click();
    await expect(hand(actor).getByRole('button')).toHaveCount(11);
    const newlyDrawn = (await order(actor)).at(-1)!;
    await hand(actor).locator(`[data-card-no="${returning}"]`).click();
    await actor.getByRole('button', { name: 'Descartar carta seleccionada' }).click();
    await expect(
      observer.getByRole('button', { name: 'Robar del descarte', exact: true }),
    ).toBeEnabled();
    await observer.getByRole('button', { name: 'Robar del descarte', exact: true }).click();
    await expect(hand(observer).getByRole('button')).toHaveCount(11);
    await hand(observer).locator(`[data-card-no="${returning}"]`).click();
    await observer.getByRole('button', { name: 'Descartar carta seleccionada' }).click();
    await expect(
      actor.getByRole('button', { name: 'Robar del descarte', exact: true }),
    ).toBeEnabled();
    await actor.getByRole('button', { name: 'Robar del descarte', exact: true }).click();
    await expect(hand(actor).getByRole('button')).toHaveCount(11);
    expect(await order(actor)).toEqual([...kept.slice(1), newlyDrawn, returning]);
    await actor.reload();
    await expect.poll(() => order(actor)).toEqual([...kept.slice(1), newlyDrawn, returning]);
    expect(errors).toEqual([]);
  } finally {
    await extra.close();
  }
});

test('an account recovers its seat from an isolated device while outsiders cannot enter a started room', async ({
  page,
  browser,
  harness,
}, info) => {
  test.setTimeout(60000);
  const opponentContext = await browser.newContext(info.project.use),
    device = await browser.newContext(info.project.use);
  const opponent = await opponentContext.newPage(),
    phone = await device.newPage();
  const email = `recover-${randomUUID()}@example.com`,
    password = 'mis cartas entre dispositivos';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
    await page.getByLabel('Tu nombre en la mesa').fill('Cuenta viajera');
    await page.getByLabel('Correo electrónico').fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Crear mi cuenta' }).click();
    await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
    const code = await create(page);
    await guest(opponent, 'Compañero espera', harness.url);
    await join(opponent, code);
    await expect(page.getByRole('button', { name: 'Repartir y empezar' })).toBeEnabled();
    await page.getByRole('button', { name: 'Repartir y empezar' }).click();
    await expect(hand(page).getByRole('button')).toHaveCount(10);
    const original = await order(page);
    await page.close();
    await guest(phone, 'Cuenta viajera', harness.url);
    await join(phone, code);
    await expect(phone.getByRole('alert')).toContainText('ya comenzó');
    await openAccount(phone);
    await phone.getByRole('button', { name: 'Cerrar sesión' }).click();
    await phone.getByLabel('Correo electrónico').fill(email);
    await phone.getByLabel('Contraseña', { exact: true }).fill(password);
    await phone.getByRole('button', { name: 'Entrar a Apuntado' }).click();
    await expect(hand(phone).getByRole('button')).toHaveCount(10);
    expect(await order(phone)).toEqual(original);
    await expect(
      phone.getByRole('list', { name: 'Jugadores en la sala' }).getByRole('listitem'),
    ).toHaveCount(2);
    await expect(phone.getByText('PARTIDA TERMINADA', { exact: true })).toHaveCount(0);
  } finally {
    await opponentContext.close();
    await device.close();
  }
});
