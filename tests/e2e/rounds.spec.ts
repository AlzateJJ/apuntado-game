import { test, expect } from './fixtures.js';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { arrangeTable } from '../helpers/arrange-table.js';
import { full433, full55, loose, suit10, touch5 } from '../helpers/rules-fixtures.js';

async function guest(page: Page, name: string, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByLabel('Tu nombre en la mesa').fill(name);
  await page.getByRole('button', { name: 'Entrar como invitado', exact: true }).click();
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
}
for (const mode of ['Clásica', 'Apuntado'] as const)
  test(`${mode}: closes, explains hands, recovers results and returns home`, async ({
    page,
    browser,
    harness,
  }, info) => {
    const context = await browser.newContext(info.project.use),
      other = await context.newPage();
    const errors: string[] = [],
      polling: string[] = [];
    for (const p of [page, other]) {
      p.on('pageerror', (e) => errors.push(e.message));
      p.on('request', (r) => {
        if (r.url().includes('transport=polling')) polling.push(r.url());
      });
    }
    try {
      const name = `Cierre ${randomUUID().slice(0, 6)}`;
      await guest(page, name, harness.url);
      await page.getByRole('radio', { name: new RegExp(mode) }).check();
      await page.getByLabel('Número máximo de jugadores').selectOption('2');
      await page.getByRole('button', { name: 'Crear sala' }).click();
      const code = await page.getByTestId('room-code').innerText();
      await guest(other, `Compañero ${randomUUID().slice(0, 6)}`, harness.url);
      await other.getByLabel('Código de la sala').fill(code);
      await other.getByRole('button', { name: 'Unirme a la sala' }).click();
      await expect(
        page.getByRole('list', { name: 'Jugadores en la sala' }).getByRole('listitem'),
      ).toHaveCount(2);
      await page.getByRole('button', { name: 'Repartir y empezar' }).click();
      await expect(page.getByRole('group', { name: 'Tu mano' }).getByRole('button')).toHaveCount(
        10,
      );
      const game = (await harness.pool.query('SELECT * FROM game WHERE join_code=$1', [code]))
        .rows[0];
      const actor = game.host_player_id;
      const opponent = (
        await harness.pool.query(
          'SELECT player_id FROM participation WHERE game_id=$1 AND player_id<>$2',
          [game.game_id, actor],
        )
      ).rows[0].player_id;
      const arrange = async (a: number[], b: number[]) => {
        await arrangeTable(harness.pool, game.game_id, { [actor]: a, [opponent]: b }, actor);
        await page.reload();
        await other.reload();
        await expect(page.getByRole('button', { name: 'Cerrar por combinaciones' })).toBeEnabled();
      };
      if (mode === 'Clásica') {
        await arrange(full55(), full433(2));
        await page.getByRole('button', { name: 'Cerrar por combinaciones' }).click();
        await expect(page.getByRole('alert')).toContainText('4, 3 y 3');
        await expect(page.getByRole('button', { name: 'Robar del mazo' })).toBeDisabled();
        await expect(other.getByRole('region', { name: 'Acta de ronda 1' })).toHaveCount(0);
        await arrange(full433(), full433(2));
        await page.getByRole('button', { name: 'Cerrar por combinaciones' }).click();
        await expect(page.getByRole('heading', { name: '¡Ganaste!' })).toBeVisible();
        await expect(other.getByRole('heading', { name: `Ganó ${name}!` })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Acta de ronda 1' })).toBeVisible();
        await expect(page.getByRole('table')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Repartir siguiente ronda' })).toHaveCount(0);
      } else {
        await arrange(touch5(), full433(2));
        await page.getByRole('button', { name: 'Tocar', exact: true }).click();
        await expect(page.getByRole('table')).toContainText('-5');
        await expect(other.getByRole('region', { name: 'Acta de ronda 1' })).toContainText(
          'Toque aceptado, sin premio',
        );
        await page.getByRole('button', { name: 'Repartir siguiente ronda' }).click();
        await expect(page.getByRole('group', { name: 'Tu mano' }).getByRole('button')).toHaveCount(
          10,
        );
        await page.getByText('Consultar rondas anteriores (1)').click();
        await page.getByLabel('Ronda cerrada').selectOption('1');
        await expect(page.getByRole('region', { name: 'Acta de ronda 1' })).toContainText(
          '5 puntos',
        );
        for (let round = 2; round <= 3; round++) {
          await arrange(
            suit10(),
            loose().map((id) => id + 52),
          );
          await page.getByRole('button', { name: 'Cerrar por pintas' }).click();
          await expect(page.getByRole('region', { name: `Acta de ronda ${round}` })).toContainText(
            '+25',
          );
          if (round === 2) {
            await page.getByRole('button', { name: 'Repartir siguiente ronda' }).click();
            await expect(
              page.getByRole('group', { name: 'Tu mano' }).getByRole('button'),
            ).toHaveCount(10);
          }
        }
        await expect(page.getByRole('heading', { name: '¡Ganaste!' })).toBeVisible();
        await expect(page.getByRole('table')).toContainText('+45');
        await expect(other.getByRole('table')).toContainText('Eliminado');
      }
      await page.reload();
      await expect(page.getByRole('heading', { name: '¡Ganaste!' })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await mkdir('.local', { recursive: true });
      await page.screenshot({
        path: `.local/result-${mode === 'Clásica' ? 'classic' : 'apuntado'}-${info.project.name}.png`,
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Volver al inicio' }).click();
      await expect(page.getByRole('button', { name: 'Crear sala' })).toBeVisible();
      await expect(other.getByRole('heading', { name: `Ganó ${name}!` })).toBeVisible();
      await other.getByRole('button', { name: 'Volver al inicio' }).click();
      await expect(other.getByRole('button', { name: 'Crear sala' })).toBeVisible();
      expect(errors).toEqual([]);
      expect(polling).toEqual([]);
    } finally {
      await context.close();
    }
  });
