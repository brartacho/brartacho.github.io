import { test, expect } from '@playwright/test';

// Credenciais via env var — se não definidas, testes autenticados são pulados
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const HAS_CREDS   = Boolean(ADMIN_EMAIL && ADMIN_PASS);

// ─── /admin — LOGIN ────────────────────────────────────────────────────────
test.describe('ADMIN /admin — login', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
  });

  test('rota carrega com status 200', async ({ page }) => {
    const response = await page.goto('/admin', { waitUntil: 'networkidle' });
    expect(response.status()).toBe(200);
    await expect(page.locator('body')).not.toContainText('NOT_FOUND');
  });

  test('campo de email/telefone visível', async ({ page }) => {
    // Campo usa type="text" com id="loginUsername"
    await expect(page.locator('#loginUsername')).toBeVisible();
  });

  test('campo de senha visível', async ({ page }) => {
    await expect(page.locator('#loginPassword')).toBeVisible();
  });

  test('toggle de visibilidade da senha funciona', async ({ page }) => {
    const passInput = page.locator('#loginPassword');
    const toggle    = page.locator('#pwToggleBtn');
    await toggle.click();
    await expect(passInput).toHaveAttribute('type', 'text');
    await toggle.click();
    await expect(passInput).toHaveAttribute('type', 'password');
  });

  test('credenciais inválidas exibem mensagem de erro', async ({ page }) => {
    await page.locator('#loginUsername').fill('invalido@teste.com');
    await page.locator('#loginPassword').fill('senha-errada-123');
    // Botão de submit é #loginBtn (sem type="submit")
    await page.locator('#loginBtn').click();
    // Erro exibido via #loginError (display: block)
    await expect(page.locator('#loginError')).toBeVisible({ timeout: 10000 });
  });

  test('modal "esqueci a senha" abre', async ({ page }) => {
    await page.locator('button.forgot-link').click();
    await expect(page.locator('#forgotModal')).toBeVisible({ timeout: 5000 });
  });

  test('modal "esqueci a senha" fecha', async ({ page }) => {
    await page.locator('button.forgot-link').click();
    await expect(page.locator('#forgotModal')).toBeVisible({ timeout: 5000 });
    await page.locator('#forgotModal .forgot-close').click();
    await expect(page.locator('#forgotModal')).toBeHidden({ timeout: 5000 });
  });
});

// ─── /admin — PAINEL AUTENTICADO ──────────────────────────────────────────
// Login feito uma única vez no beforeAll; cookies capturados via storageState
// (JWT fica em cookie httpOnly — JS nunca acessa diretamente)
let _authCookies = null;

test.describe('ADMIN — painel autenticado', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD para rodar estes testes');

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const pg  = await ctx.newPage();
    await pg.goto('/admin', { waitUntil: 'networkidle' });
    // Foca o campo para disparar _loginFormStartedAt, depois aguarda > 800ms (bot-detection fillMs)
    await pg.locator('#loginUsername').focus();
    await pg.waitForTimeout(1100);
    await pg.locator('#loginUsername').fill(ADMIN_EMAIL);
    await pg.locator('#loginPassword').fill(ADMIN_PASS);
    await pg.locator('#loginBtn').click();
    // Aguarda o painel aparecer (cookie httpOnly é setado pelo servidor)
    const ok = await pg.waitForSelector('.app-logout', { state: 'visible', timeout: 15000 })
      .then(() => true).catch(() => false);
    if (ok) {
      const state = await ctx.storageState();
      _authCookies = state.cookies; // inclui o cookie httpOnly de sessão
    }
    await ctx.close();
  });

  test.beforeEach(async ({ page }) => {
    if (_authCookies?.length) {
      await page.context().addCookies(_authCookies);
    }
    await page.goto('/admin', { waitUntil: 'networkidle' });
    if (_authCookies?.length) {
      await page.waitForSelector('.app-logout', { state: 'visible', timeout: 10000 }).catch(() => {});
    }
  });

  test('login bem-sucedido exibe painel', async ({ page }) => {
    await expect(page.locator('.tab-btn').first()).toBeVisible({ timeout: 10000 });
  });

  test('abas principais visíveis (mínimo 4)', async ({ page }) => {
    const count = await page.locator('.tab-btn').count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('aba Currículos ativa por padrão e tem formulário de upload', async ({ page }) => {
    await expect(page.locator('.upload-zone').first()).toBeVisible({ timeout: 5000 });
  });

  test('aba Tokens abre e tem formulário de criação', async ({ page }) => {
    const tokenTab = page.locator('.tab-btn').filter({ hasText: /token/i }).first();
    await tokenTab.click();
    await expect(page.locator('#tokenCV')).toBeVisible({ timeout: 5000 });
  });

  test('aba Logs abre e tem tabela', async ({ page }) => {
    const logsTab = page.locator('.tab-btn').filter({ hasText: /log/i }).first();
    await logsTab.click();
    await expect(page.locator('#tab-logs table')).toBeVisible({ timeout: 5000 });
  });

  test('aba Gestão de Vagas abre e exibe tabela de candidaturas', async ({ page }) => {
    const vagasTab = page.locator('.tab-btn').filter({ hasText: /vaga/i }).first();
    await vagasTab.click();
    await expect(page.locator('.vagas-table')).toBeVisible({ timeout: 5000 });
  });

  test('botão Nova vaga abre formulário inline', async ({ page }) => {
    const vagasTab = page.locator('.tab-btn').filter({ hasText: /vaga/i }).first();
    await vagasTab.click();
    await page.locator('button', { hasText: /nova vaga/i }).click();
    await expect(page.locator('#novaVagaForm')).toBeVisible({ timeout: 3000 });
  });

  test('filtros de status estão presentes na aba Gestão de Vagas', async ({ page }) => {
    const vagasTab = page.locator('.tab-btn').filter({ hasText: /vaga/i }).first();
    await vagasTab.click();
    const count = await page.locator('.vagas-filter-chip').count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('botão de logout presente', async ({ page }) => {
    await expect(page.locator('.app-logout')).toBeVisible();
  });
});

// ─── /admin/reset ─────────────────────────────────────────────────────────
test.describe('ADMIN /admin/reset', () => {
  test('rota carrega com status 200', async ({ page }) => {
    const response = await page.goto('/admin/reset', { waitUntil: 'networkidle' });
    expect(response.status()).toBe(200);
    await expect(page.locator('body')).not.toContainText('NOT_FOUND');
  });

  test('página tem campos de nova senha', async ({ page }) => {
    await page.goto('/admin/reset', { waitUntil: 'networkidle' });
    const passFields = page.locator('input[type="password"]');
    const count      = await passFields.count();
    const bodyText   = await page.locator('body').textContent();
    // Sem token: formArea fica oculto e título muda para "Link inválido"
    const isValidState = count >= 1;
    const isErrorState = /inválido|expirado|invalid|expired|error/i.test(bodyText);
    expect(isValidState || isErrorState).toBe(true);
  });

  test('sem token na URL mostra tela adequada', async ({ page }) => {
    await page.goto('/admin/reset', { waitUntil: 'networkidle' });
    await expect(page.locator('body')).not.toContainText('NOT_FOUND');
    const body = await page.locator('body').textContent();
    expect(body.length).toBeGreaterThan(100);
  });

  test('título da página é sobre redefinição de senha', async ({ page }) => {
    await page.goto('/admin/reset', { waitUntil: 'networkidle' });
    const title = await page.title();
    expect(title.toLowerCase()).toMatch(/reset|redefin|senha|artacho/i);
  });
});
