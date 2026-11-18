import { test, expect } from './fixtures.js';
import { randomUUID } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { arrangeTable } from '../helpers/arrange-table.js';
import { full433 } from '../helpers/rules-fixtures.js';
import { cards } from '../../apps/server/src/game/domain.js';

test('six isolated browsers keep hands private and receive the same committed acta', async ({
  browser,
  harness,
}, info) => {
  test.setTimeout(60000);
  const contexts: BrowserContext[] = [];
  try {
    const pages = [];
    for (let seat = 0; seat < 6; seat++) {
      const context = await browser.newContext(info.project.use);
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      await page.goto(harness.url);
      await page.getByRole('button', { name: 'Invitado', exact: true }).click();
      await page
        .getByLabel('Tu nombre en la mesa')
        .fill(`Persona ${seat + 1} ${randomUUID().slice(0, 4)}`);
      await page.getByRole('button', { name: 'Entrar como invitado', exact: true }).click();
      await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
    }
    const host = pages[0]!;
    await host.getByRole('button', { name: 'Crear sala' }).click();
    const code = await host.getByTestId('room-code').innerText();
    for (const page of pages.slice(1)) {
      await page.getByLabel('Código de la sala').fill(code);
      await page.getByRole('button', { name: 'Unirme a la sala' }).click();
      await expect(page.getByTestId('room-code')).toHaveText(code);
    }
    await expect(
      host.getByRole('list', { name: 'Jugadores en la sala' }).getByRole('listitem'),
    ).toHaveCount(6);
    await host.getByRole('button', { name: 'Repartir y empezar' }).click();
    const hands: string[][] = [];
    for (const page of pages) {
      const hand = page.getByRole('group', { name: 'Tu mano' }).getByRole('button');
      await expect(hand).toHaveCount(10);
      hands.push(
        await hand.evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute('aria-label')!),
        ),
      );
    }
    expect(new Set(hands.flat()).size).toBe(60);
    const game = (await harness.pool.query('SELECT * FROM game WHERE join_code=$1', [code]))
      .rows[0];
    const roster = (
      await harness.pool.query(
        'SELECT player_id FROM participation WHERE game_id=$1 ORDER BY seat',
        [game.game_id],
      )
    ).rows;
    const winning = full433(),
      second = full433(2),
      used = new Set([...winning, ...second]);
    const spare = cards()
      .map((c) => c.cardNo)
      .filter((id) => !used.has(id));
    const fixture: Record<string, number[]> = {
      [roster[0].player_id]: winning,
      [roster[1].player_id]: second,
    };
    for (const player of roster.slice(2)) fixture[player.player_id] = spare.splice(0, 10);
    await arrangeTable(harness.pool, game.game_id, fixture, roster[0].player_id);
    await host.reload();
    await host.getByRole('button', { name: 'Cerrar por combinaciones' }).click();
    for (const page of pages) {
      const acta = page.getByRole('region', { name: 'Acta de ronda 1' });
      await expect(acta).toBeVisible();
      await expect(acta.locator('.player-evidence')).toHaveCount(6);
      await expect(acta.locator('.evidence-card')).toHaveCount(60);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  } finally {
    for (const context of contexts) await context.close();
  }
});
