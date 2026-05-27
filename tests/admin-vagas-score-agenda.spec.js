import { test, expect } from '@playwright/test';

// Testes das features: fit_score + agendamento de etapas + Google Agenda
// Pressupõe que existem candidaturas com fit_score no banco (já populadas).
//
// IMPORTANTE: Em produção o login exige token Cloudflare Turnstile que não pode
// ser bypassed pelo Playwright. Rode contra localhost:
//   BASE_URL=http://localhost:3000 npx playwright test tests/admin-vagas-score-agenda.spec.js

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const HAS_CREDS   = Boolean(ADMIN_EMAIL && ADMIN_PASS);

let _adminCookies = null;

test.describe('ADMIN — fit_score + agendamento de etapas', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD para rodar');
  test.setTimeout(60_000);

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext();
    const pg  = await ctx.newPage();
    try {
      await pg.goto('/admin', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await pg.locator('#loginUsername').focus();
      await pg.waitForTimeout(1100);
      await pg.locator('#loginUsername').fill(ADMIN_EMAIL);
      await pg.locator('#loginPassword').fill(ADMIN_PASS);
      await pg.locator('#loginBtn').click();
      await pg.waitForSelector('.app-logout', { state: 'visible', timeout: 60_000 });
      _adminCookies = (await ctx.storageState()).cookies;
    } catch (e) {
      console.warn('Login falhou:', e.message);
    } finally {
      await ctx.close().catch(() => {});
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!_adminCookies?.length, 'Sem cookies — beforeAll falhou');
    await page.context().addCookies(_adminCookies);
    await page.goto('/admin', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('.app-logout', { state: 'visible', timeout: 15_000 }).catch(() => {});
    await page.locator('.tab-btn').filter({ hasText: /vaga/i }).first().click();
    await expect(page.locator('.vagas-table')).toBeVisible({ timeout: 15_000 });
  });

  test('coluna Score visível no cabeçalho da tabela', async ({ page }) => {
    await expect(page.locator('.vagas-table thead .col-score')).toBeVisible();
    await expect(page.locator('#sort-fit_score')).toBeAttached();
  });

  test('chip de sort por Score existe na barra', async ({ page }) => {
    await expect(page.locator('#sort-chip-fit_score')).toBeVisible();
  });

  test('badges de score aparecem nas linhas (verde/ciano/amarelo)', async ({ page }) => {
    const badges = page.locator('.fit-score-badge');
    const count = await badges.count();
    expect(count).toBeGreaterThan(0);
    const classes = await badges.first().getAttribute('class');
    expect(classes).toMatch(/score-(high|mid|low)/);
  });

  test('ordenação por fit_score reordena a lista', async ({ page }) => {
    await page.locator('#sort-chip-fit_score').click();
    await page.waitForTimeout(300);
    const scores = await page.locator('.fit-score-badge').allInnerTexts();
    const numeric = scores.map(s => parseFloat(s)).filter(n => !isNaN(n));
    // Esperado: ordem descendente após o clique no chip
    for (let i = 1; i < numeric.length; i++) {
      expect(numeric[i]).toBeLessThanOrEqual(numeric[i - 1]);
    }
  });

  test('drawer abre com score no header (chips) para candidatura com fit_score', async ({ page }) => {
    // Abre primeira linha que tenha badge de score
    const rowWithScore = page.locator('.vagas-table tr', { has: page.locator('.fit-score-badge') }).first();
    await rowWithScore.click();
    await expect(page.locator('#vagasDrawer.open')).toBeVisible();
    // Verifica que existe um chip com score no header (texto numérico tipo "8.5")
    const drawerScoreChip = page.locator('#vagasDrawer .dinfo-chip.fit-score-badge');
    await expect(drawerScoreChip).toBeVisible();
  });

  test('timeline mostra ícone de relógio em etapas agendáveis (não em Enviado)', async ({ page }) => {
    const rowWithScore = page.locator('.vagas-table tr', { has: page.locator('.fit-score-badge') }).first();
    await rowWithScore.click();
    await expect(page.locator('#vagasDrawer.open')).toBeVisible();

    // "Enviado" não deve ter o relógio
    const enviadoRow = page.locator('#drawerTimeline .stage-row', { hasText: 'Enviado' });
    await expect(enviadoRow.locator('button[title*="Agendar"]')).toHaveCount(0);

    // Outras etapas (ex: Triagem, Entrevista) devem ter o relógio
    const clockButtons = page.locator('#drawerTimeline button[title*="Agendar"]');
    expect(await clockButtons.count()).toBeGreaterThan(0);
  });

  test('clicar no relógio revela input datetime-local', async ({ page }) => {
    const rowWithScore = page.locator('.vagas-table tr', { has: page.locator('.fit-score-badge') }).first();
    await rowWithScore.click();
    await expect(page.locator('#vagasDrawer.open')).toBeVisible();

    const clockBtn = page.locator('#drawerTimeline button[title*="Agendar"]').first();
    const input = clockBtn.locator('xpath=following-sibling::input[@type="datetime-local"]');
    await expect(input).toHaveCSS('display', 'none');
    await clockBtn.click();
    await expect(input).not.toHaveCSS('display', 'none');
  });

  test('drawer sem scroll horizontal', async ({ page }) => {
    const rowWithScore = page.locator('.vagas-table tr', { has: page.locator('.fit-score-badge') }).first();
    await rowWithScore.click();
    await expect(page.locator('#vagasDrawer.open')).toBeVisible();

    const body = page.locator('#drawerBody');
    const dims = await body.evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(dims.sw).toBeLessThanOrEqual(dims.cw + 1); // +1px tolerância de subpixel
  });

  test('drawer-actions tem flex-wrap:wrap (sem overflow horizontal escondido)', async ({ page }) => {
    const rowWithScore = page.locator('.vagas-table tr', { has: page.locator('.fit-score-badge') }).first();
    await rowWithScore.click();
    await expect(page.locator('#vagasDrawer.open')).toBeVisible();

    const flexWrap = await page.locator('#drawerBody .drawer-actions').evaluate(
      el => getComputedStyle(el).flexWrap
    );
    expect(flexWrap).toBe('wrap');
  });

  test('buildGCalLink gera URL válida do Google Calendar', async ({ page }) => {
    const result = await page.evaluate(() => {
      if (typeof window.buildGCalLink !== 'function') return null;
      return window.buildGCalLink('Test Event', '2026-06-01T14:30');
    });
    expect(result).not.toBeNull();
    expect(result).toContain('calendar.google.com/calendar/render');
    expect(result).toContain('action=TEMPLATE');
    expect(result).toContain('Test+Event');
    expect(result).toMatch(/dates=20260601T143000\/\d{8}T\d{6}/);
  });
});
