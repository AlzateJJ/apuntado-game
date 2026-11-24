import { test, expect, openNavigation, openAccount } from './fixtures.js';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

test('access is responsive and validates guest input', async ({ page }, info) => {
  const exceptions: string[] = [];
  page.on('pageerror', (error) => exceptions.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Qué bueno verte.' })).toBeVisible();
  await mkdir('.local', { recursive: true });
  await page.screenshot({ path: `.local/access-${info.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByRole('button', { name: 'Entrar como invitado', exact: true }).click();
  await expect(page.getByText('Escribe al menos 2 caracteres.')).toBeVisible();
  expect(exceptions).toEqual([]);
});
test('guest connects by websocket and survives a page reload', async ({ page, context }) => {
  const sockets: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.goto('/');
  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByLabel('Tu nombre en la mesa').fill('Invitado de prueba');
  const response = page.waitForResponse((r) => r.url().endsWith('/api/auth/guest'));
  await page.getByRole('button', { name: 'Entrar como invitado', exact: true }).click();
  const player = (await (await response).json()).player;
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
  const refreshed = page.waitForResponse((r) => r.url().endsWith('/api/auth/refresh'));
  await page.reload();
  expect((await (await refreshed).json()).player.id).toBe(player.id);
  await openNavigation(page);
  await expect(
    page.getByText('Invitado de prueba', { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
  expect(sockets.length).toBeGreaterThanOrEqual(2);
  expect(sockets.every((url) => url.includes('transport=websocket'))).toBe(true);
  expect(
    (await context.cookies()).find((cookie) => cookie.name === 'apuntado_refresh')?.httpOnly,
  ).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
  await openAccount(page);
  await page.getByRole('button', { name: 'Mi cuenta', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Mi cuenta.' })).toBeVisible();
  await expect(
    page.getByText('Tu acceso de invitado pertenece a este navegador.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Volver a mi mesa' }).click();
  await expect(page.getByRole('heading', { name: 'Arma tu mesa.' })).toBeVisible();
});
test('register, log out, reject a bad password, and sign in with the same account', async ({
  page,
}, info) => {
  const email = `player-${randomUUID()}@example.com`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
  await page.getByLabel('Tu nombre en la mesa').fill('Mariana');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill('una frase larga y segura');
  await page.getByRole('button', { name: 'Crear mi cuenta' }).click();
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
  await openAccount(page);
  await expect(page.getByText(email, { exact: true }).filter({ visible: true })).toBeVisible();
  await page.screenshot({ path: `.local/account-menu-${info.project.name}.png`, scale: 'css' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Cerrar sesión', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Abrir cuenta de usuario', exact: true }),
  ).toBeFocused();
  await openAccount(page);
  await page.getByRole('button', { name: 'Mi cuenta', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Mi cuenta.', exact: true })).toBeVisible();
  await expect(page.locator('.account-panel dd').filter({ hasText: email })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: `.local/account-page-${info.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Volver a mi mesa' }).click();
  await expect(page.getByRole('heading', { name: 'Arma tu mesa.' })).toBeVisible();
  const capacity = page.getByRole('group', { name: 'Número máximo de jugadores' });
  await expect(capacity.getByRole('radio', { name: '6 jugadores' })).toBeChecked();
  await capacity.getByRole('radio', { name: '4 jugadores' }).check();
  await capacity.getByRole('radio', { name: '4 jugadores' }).press('ArrowLeft');
  await expect(capacity.getByRole('radio', { name: '3 jugadores' })).toBeChecked();
  await page.screenshot({ path: `.local/room-selector-${info.project.name}.png`, fullPage: true });
  await page.reload();
  await openAccount(page);
  await expect(page.getByText(email, { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('heading', { name: 'Qué bueno verte.' })).toBeVisible();
  await page.getByLabel('Correo electrónico').fill(email.toUpperCase());
  await page.getByLabel('Contraseña', { exact: true }).fill('equivocada');
  await page.getByRole('button', { name: 'Entrar a Apuntado' }).click();
  await expect(page.getByRole('alert')).toContainText('no coinciden');
  await page.getByLabel('Contraseña', { exact: true }).fill('una frase larga y segura');
  await page.getByRole('button', { name: 'Entrar a Apuntado' }).click();
  await openNavigation(page);
  await expect(page.getByText('Mariana', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
});
test('multiple tabs renew safely and logout reaches both', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByLabel('Tu nombre en la mesa').fill('Dos pestañas');
  await page.getByRole('button', { name: 'Entrar como invitado', exact: true }).click();
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByText('Conexión activa', { exact: true })).toBeVisible();
  await Promise.all([page.reload(), other.reload()]);
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
  await expect(other.getByText('Conexión activa', { exact: true })).toBeVisible();
  await openAccount(page);
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('heading', { name: 'Qué bueno verte.' })).toBeVisible();
  await expect(other.getByRole('heading', { name: 'Qué bueno verte.' })).toBeVisible();
  await other.close();
});
test('connection recovers after transport loss', async ({ page, harness }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Invitado', exact: true }).click();
  await page.getByLabel('Tu nombre en la mesa').fill('Reconexión');
  await page.getByRole('button', { name: 'Entrar como invitado', exact: true }).click();
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible();
  for (const client of Object.values(harness.application.io.engine.clients)) client.close();
  await expect(page.getByText('Sin conexión', { exact: true })).toBeVisible();
  await expect(page.getByText('Conexión activa', { exact: true })).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: `.local/connected-${info.project.name}.png`, fullPage: true });
});
