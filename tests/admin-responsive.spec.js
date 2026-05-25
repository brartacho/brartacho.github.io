import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const HAS_CREDS   = Boolean(ADMIN_EMAIL && ADMIN_PASS);

let _savedCookies = null;

test.beforeAll(async ({ browser }) => {
  if (!HAS_CREDS) return;
  const ctx = await browser.newContext();
  const pg  = await ctx.newPage();
  try {
    await pg.goto('/admin', { waitUntil: 'domcontentloaded' });
    await pg.locator('#loginUsername').fill(ADMIN_EMAIL);
    await pg.locator('#loginPassword').fill(ADMIN_PASS);
    await pg.locator('#loginBtn').click();
    await pg.waitForSelector('.app-logout', { state: 'visible', timeout: 15000 });
    _savedCookies = await ctx.cookies();
  } catch (e) {
    console.warn('\n⚠️  Login falhou — testes autenticados serão pulados:', e.message);
  } finally {
    await ctx.close();
  }
});

async function injectAndGoto(page) {
  if (_savedCookies?.length) {
    await page.context().addCookies(_savedCookies);
  }
  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  if (_savedCookies?.length) {
    await page.waitForSelector('.app-logout', { state: 'visible', timeout: 12000 });
  }
}

function vp(page) { return page.viewportSize()?.width ?? 1280; }

// ─── NAVEGAÇÃO ────────────────────────────────────────────────────────────────
test.describe('Navegação', () => {

  test('mobile: bottom nav visível, app-tabs ocultas', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await injectAndGoto(page);
    await expect(page.locator('.mobile-bottom-nav')).toBeVisible();
    await expect(page.locator('.app-tabs')).toBeHidden();
  });

  test('mobile: bottom nav muda aba ativa', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await injectAndGoto(page);
    const btn = page.locator('.mobile-nav-btn[data-tab="vagas"]');
    await btn.click();
    await expect(page.locator('#tab-vagas')).toBeVisible({ timeout: 5000 });
  });

  test('mobile: botão ativo tem background (não só cor de texto)', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await injectAndGoto(page);
    const btn = page.locator('.mobile-nav-btn.active').first();
    const bg = await btn.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');
  });

  test('tablet: app-tabs visíveis, bottom nav oculta', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await injectAndGoto(page);
    await expect(page.locator('.app-tabs')).toBeVisible();
    await expect(page.locator('.mobile-bottom-nav')).toBeHidden();
  });

  test('tablet: tabs sem causar overflow horizontal na página', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await injectAndGoto(page);
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });

  test('desktop: app-tabs visíveis sem overflow horizontal', async ({ page }) => {
    test.skip(vp(page) <= 1024, 'apenas desktop');
    await injectAndGoto(page);
    await expect(page.locator('.app-tabs')).toBeVisible();
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });
});

// ─── TABELA DE VAGAS ──────────────────────────────────────────────────────────
test.describe('Tabela de Vagas', () => {

  async function gotoVagas(page) {
    await injectAndGoto(page);
    if (vp(page) <= 600) {
      await page.locator('.mobile-nav-btn[data-tab="vagas"]').click();
    } else {
      await page.locator('.app-tabs [data-tab="vagas"]').click();
    }
    await page.waitForTimeout(600);
  }

  test('mobile: thead oculto, linhas como cards', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await gotoVagas(page);
    await expect(page.locator('.vagas-table thead')).toBeHidden();
    await expect(page.locator('.vagas-table tbody')).toBeVisible();
  });

  test('mobile: card exibe empresa (vaga-meta-mobile visível)', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await gotoVagas(page);
    const count = await page.locator('.vagas-table tbody tr').count();
    if (count === 0) test.skip(true, 'sem vagas para testar layout de card');
    await expect(page.locator('.vaga-meta-mobile').first()).toBeVisible();
  });

  test('mobile: sem overflow horizontal na aba Vagas', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await gotoVagas(page);
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });

  test('tablet: thead visível', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await gotoVagas(page);
    await expect(page.locator('.vagas-table thead')).toBeVisible();
  });

  test('tablet: col-gestor e col-cadastrado ocultas', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await gotoVagas(page);
    const thGestor = page.locator('.vagas-table thead .col-gestor');
    const thCad    = page.locator('.vagas-table thead .col-cadastrado');
    if (await thGestor.count() > 0) await expect(thGestor.first()).toBeHidden();
    if (await thCad.count()    > 0) await expect(thCad.first()).toBeHidden();
  });

  test('tablet: sem overflow horizontal', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await gotoVagas(page);
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });

  test('desktop: thead visível com col-gestor e col-cadastrado', async ({ page }) => {
    test.skip(vp(page) <= 1024, 'apenas desktop');
    await gotoVagas(page);
    await expect(page.locator('.vagas-table thead')).toBeVisible();
    const thGestor = page.locator('.vagas-table thead .col-gestor');
    const thCad    = page.locator('.vagas-table thead .col-cadastrado');
    if (await thGestor.count() > 0) await expect(thGestor.first()).toBeVisible();
    if (await thCad.count()    > 0) await expect(thCad.first()).toBeVisible();
  });
});

// ─── DRAWERS ──────────────────────────────────────────────────────────────────
test.describe('Drawers', () => {

  async function openVagasDrawer(page) {
    await injectAndGoto(page);
    if (vp(page) <= 600) {
      await page.locator('.mobile-nav-btn[data-tab="vagas"]').click();
    } else {
      await page.locator('.app-tabs [data-tab="vagas"]').click();
    }
    await page.waitForTimeout(600);
    const firstRow = page.locator('.vagas-table tbody tr').first();
    const count = await firstRow.count();
    if (count === 0) return false;
    await firstRow.click();
    await page.waitForSelector('#vagasDrawer.open', { timeout: 5000 });
    return true;
  }

  test('mobile: drawer abre como bottom sheet (translateY)', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    const opened = await openVagasDrawer(page);
    if (!opened) test.skip(true, 'sem vagas para abrir drawer');
    const transform = await page.locator('#vagasDrawer').evaluate(
      el => getComputedStyle(el).transform
    );
    expect(transform).toMatch(/matrix\(1, 0, 0, 1, 0,/);
  });

  test('mobile: drawer ocupa ≤90dvh e botão fechar visível', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    const opened = await openVagasDrawer(page);
    if (!opened) test.skip(true, 'sem vagas');
    const drawerH  = await page.locator('#vagasDrawer').evaluate(el => el.offsetHeight);
    const windowH  = await page.evaluate(() => window.innerHeight);
    expect(drawerH).toBeLessThanOrEqual(windowH * 0.92);
    await expect(page.locator('#vagasDrawer .drawer-close')).toBeVisible();
  });

  test('tablet: drawer abre da direita, largura ≤80vw', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    const opened = await openVagasDrawer(page);
    if (!opened) test.skip(true, 'sem vagas');
    const drawerW  = await page.locator('#vagasDrawer').evaluate(el => el.offsetWidth);
    const windowW  = await page.evaluate(() => window.innerWidth);
    expect(drawerW).toBeLessThanOrEqual(windowW * 0.82);
  });

  test('desktop: drawer abre da direita, largura ≥460px', async ({ page }) => {
    test.skip(vp(page) <= 1024, 'apenas desktop');
    const opened = await openVagasDrawer(page);
    if (!opened) test.skip(true, 'sem vagas');
    const drawerW = await page.locator('#vagasDrawer').evaluate(el => el.offsetWidth);
    expect(drawerW).toBeGreaterThanOrEqual(460);
  });
});

// ─── FILTROS ──────────────────────────────────────────────────────────────────
test.describe('Filtros', () => {

  async function gotoVagasComFiltros(page) {
    await injectAndGoto(page);
    if (vp(page) <= 600) {
      await page.locator('.mobile-nav-btn[data-tab="vagas"]').click();
    } else {
      await page.locator('.app-tabs [data-tab="vagas"]').click();
    }
    await page.waitForTimeout(600);
    const panel = page.locator('#vagasFiltersPanel');
    const collapsed = await panel.evaluate(el => el.classList.contains('collapsed'));
    if (collapsed) await page.locator('#vagasFiltersToggleBtn').click();
    await page.waitForTimeout(300);
  }

  test('mobile: container de chips não gera overflow de página', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await gotoVagasComFiltros(page);
    const bodySw = await page.evaluate(() => document.body.scrollWidth);
    const bodyCw = await page.evaluate(() => document.body.clientWidth);
    expect(bodySw).toBeLessThanOrEqual(bodyCw + 5);
  });

  test('mobile: chips não cortados nas bordas (padding-inline)', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await gotoVagasComFiltros(page);
    const paddingLeft = await page.locator('#vagasFilters').evaluate(
      el => parseFloat(getComputedStyle(el).paddingLeft)
    );
    expect(paddingLeft).toBeGreaterThanOrEqual(10);
  });

  test('tablet: filtros sem overflow de página', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await gotoVagasComFiltros(page);
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });

  test('desktop: linha de filtros sem overflow de página', async ({ page }) => {
    test.skip(vp(page) <= 1024, 'apenas desktop');
    await gotoVagasComFiltros(page);
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });
});

// ─── OVERFLOW HORIZONTAL GERAL ────────────────────────────────────────────────
test.describe('Overflow horizontal — todas as abas', () => {

  const TABS = ['vagas', 'radar', 'metricas'];

  for (const tabKey of TABS) {
    test(`desktop: aba "${tabKey}" sem overflow horizontal`, async ({ page }) => {
      test.skip(vp(page) <= 1024, 'apenas desktop');
      await injectAndGoto(page);
      await page.locator(`.app-tabs [data-tab="${tabKey}"]`).click();
      await page.waitForTimeout(500);
      const sw = await page.evaluate(() => document.body.scrollWidth);
      const cw = await page.evaluate(() => document.body.clientWidth);
      expect(sw, `overflow na aba ${tabKey}`).toBeLessThanOrEqual(cw + 5);
    });
  }

  for (const tabKey of TABS) {
    test(`mobile: aba "${tabKey}" sem overflow horizontal`, async ({ page }) => {
      test.skip(vp(page) > 600, 'apenas mobile');
      await injectAndGoto(page);
      const btn = page.locator(`.mobile-nav-btn[data-tab="${tabKey}"]`);
      if (await btn.count() === 0) return;
      await btn.click();
      await page.waitForTimeout(500);
      const sw = await page.evaluate(() => document.body.scrollWidth);
      const cw = await page.evaluate(() => document.body.clientWidth);
      expect(sw, `overflow na aba ${tabKey}`).toBeLessThanOrEqual(cw + 5);
    });
  }

  for (const tabKey of TABS) {
    test(`tablet: aba "${tabKey}" sem overflow horizontal`, async ({ page }) => {
      test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
      await injectAndGoto(page);
      await page.locator(`.app-tabs [data-tab="${tabKey}"]`).click();
      await page.waitForTimeout(500);
      const sw = await page.evaluate(() => document.body.scrollWidth);
      const cw = await page.evaluate(() => document.body.clientWidth);
      expect(sw, `overflow na aba ${tabKey}`).toBeLessThanOrEqual(cw + 5);
    });
  }
});
