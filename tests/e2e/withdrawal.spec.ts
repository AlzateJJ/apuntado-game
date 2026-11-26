import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, navigate, openAccount } from './fixtures.js';
import { arrangeTable } from '../helpers/arrange-table.js';
import { full433 } from '../helpers/rules-fixtures.js';

async function guest(page: Page, name: string, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByLabel('Tu nombre en la mesa').fill(name);
  await page.getByRole('button', { name: 'Entrar como invitado', exact: true }).click();
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
}

for (const stage of ['during-turn', 'between-rounds'] as const)
  test(`surrender ${stage} from any section returns home and updates other players and tabs`, async ({
    page,
    browser,
    harness,
  }, info) => {
    test.setTimeout(60000);
    const context = await browser.newContext(info.project.use);
    const other = await context.newPage();
    const errors: string[] = [];
    for (const p of [page, other]) p.on('pageerror', (error) => errors.push(error.message));
    try {
      const hostName = `Anfitrión ${randomUUID().slice(0, 5)}`;
      await guest(page, hostName, harness.url);
      await page
        .getByRole('radio', { name: new RegExp(stage === 'during-turn' ? 'Clásica' : 'Apuntado') })
        .check();
      await page.getByRole('radio', { name: '2 jugadores', exact: true }).check();
      await page.getByRole('button', { name: 'Crear sala', exact: true }).click();
      const code = await page.getByTestId('room-code').innerText();
      const companionName = `Compañero ${randomUUID().slice(0, 5)}`;
      await guest(other, companionName, harness.url);
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
      let oldEvidence: string | null = null;
      if (stage === 'between-rounds') {
        const opponent = (
          await harness.pool.query(
            'SELECT player_id FROM participation WHERE game_id=$1 AND player_id<>$2',
            [game.game_id, game.host_player_id],
          )
        ).rows[0].player_id;
        await arrangeTable(
          harness.pool,
          game.game_id,
          { [game.host_player_id]: full433(), [opponent]: full433(2) },
          game.host_player_id,
        );
        await page.reload();
        await page.getByRole('button', { name: 'Cerrar por combinaciones' }).click();
        await expect(
          other.getByText('Esperando a que el anfitrión reparta la siguiente ronda.'),
        ).toBeVisible();
        oldEvidence = await page.getByRole('region', { name: 'Acta de ronda 1' }).innerText();
      }
      const leaving = stage === 'during-turn' ? page : other;
      const survivor = stage === 'during-turn' ? other : page;
      const mirror = await leaving.context().newPage();
      await mirror.goto(harness.url);
      await expect(mirror.getByRole('button', { name: 'Abandonar partida' })).toBeVisible();
      const trigger = leaving.getByRole('button', { name: 'Abandonar partida' });
      const dialog = leaving.getByRole('dialog', { name: '¿Abandonar la partida?' });
      await trigger.click();
      await expect(dialog.getByRole('button', { name: 'Seguir en la partida' })).toBeFocused();
      await dialog.getByRole('button', { name: 'Seguir en la partida' }).click();
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeVisible();
      for (const section of ['Cómo jugar', 'Rondas anteriores']) {
        await navigate(leaving, section);
        await trigger.click();
        await expect(dialog).toBeVisible();
        await leaving.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
      }
      await openAccount(leaving);
      await leaving.getByRole('button', { name: 'Mi cuenta', exact: false }).click();
      await expect(leaving.getByRole('heading', { name: 'Mi cuenta.' })).toBeVisible();
      await trigger.click();
      await expect(dialog).toContainText('pero no volver a esta');
      expect(await leaving.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await mkdir('.local', { recursive: true });
      await leaving.screenshot({ path: `.local/withdrawal-${stage}-${info.project.name}.png` });
      const attempts: string[] = [];
      if (stage === 'between-rounds') {
        const socket = Array.from(harness.application.io.sockets.sockets.values()).find(
          (value) => value.data.identity.player.displayName === companionName,
        )!;
        const handler = socket.listeners('game:command')[0]!;
        socket.removeAllListeners('game:command');
        socket.on('game:command', (command, ack) => {
          if (command.type === 'game:surrender') {
            attempts.push(command.operationId);
            if (attempts.length === 1) return; // Simulate a lost request and confirmation.
          }
          Reflect.apply(handler, socket, [command, ack]);
        });
      }
      await dialog.getByRole('button', { name: 'Abandonar y volver al inicio' }).click();
      if (stage === 'between-rounds') {
        await expect(dialog.getByRole('button', { name: 'Reintentar salida' })).toBeVisible({
          timeout: 9000,
        });
        await dialog.getByRole('button', { name: 'Seguir en la partida' }).click();
        await expect(dialog).not.toBeVisible();
        await trigger.click();
        await dialog.getByRole('button', { name: 'Reintentar salida' }).click();
      }
      await expect(leaving.getByRole('button', { name: 'Crear sala', exact: true })).toBeVisible();
      await expect(mirror.getByRole('button', { name: 'Crear sala', exact: true })).toBeVisible();
      await expect(survivor.getByRole('heading', { name: '¡Ganaste!' })).toBeVisible();
      await expect(survivor.getByRole('list', { name: 'Jugadores en la sala' })).toContainText(
        'Abandonó la partida',
      );
      if (oldEvidence !== null)
        expect(await survivor.getByRole('region', { name: 'Acta de ronda 1' }).innerText()).toBe(
          oldEvidence,
        );
      await leaving.getByRole('button', { name: 'Crear sala', exact: true }).click();
      await expect(leaving.getByTestId('room-code')).toBeVisible();
      expect(await leaving.getByTestId('room-code').innerText()).not.toBe(code);
      if (stage === 'between-rounds') {
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toBe(attempts[0]);
      }
      expect(errors).toEqual([]);
      await mirror.close();
    } finally {
      await context.close();
    }
  });
