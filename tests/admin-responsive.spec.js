import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let _sharedJwt = null;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('/admin/login');
    await page.fill('input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[name="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');

    // Aguarda navegação e captura JWT
    await page.waitForURL('/admin/**');
    const cookies = await context.cookies();
    const jwtCookie = cookies.find(c => c.name === 'token');

    if (!jwtCookie) {
      throw new Error('JWT token não encontrado após login');
    }

    _sharedJwt = jwtCookie.value;
  } catch (error) {
    console.error('Erro ao capturar JWT no beforeAll:', error);
    throw error;
  } finally {
    await context.close();
  }
});

async function injectAndGoto(page) {
  // Injeta JWT no localStorage
  await page.goto('/');
  await page.evaluate((jwt) => {
    localStorage.setItem('token', jwt);
  }, _sharedJwt);
  await page.goto('/admin');
}

function vp(page) {
  // Retorna a largura da viewport
  return page.viewportSize().width;
}

test('desktop: deve exibir layout completo', async ({ page }) => {
  await injectAndGoto(page);
  expect(vp(page)).toBe(1280);
  // Testes específicos do desktop aqui
});

test('tablet: deve exibir tabs no topo', async ({ page }) => {
  await injectAndGoto(page);
  expect(vp(page)).toBe(820);
  // Testes específicos do tablet aqui
});

test('mobile: deve exibir nav no rodapé', async ({ page }) => {
  await injectAndGoto(page);
  expect(vp(page)).toBe(390);
  // Testes específicos do mobile aqui
});
