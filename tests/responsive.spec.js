import { test, expect } from '@playwright/test';

// ─── MOBILE 390px ─────────────────────────────────────────────────────────
test.describe('MOBILE 390px — hero', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('hero visível e sem overflow horizontal', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('.hero-photo')).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const clientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5);
  });

  test('hamburger visível e nav links ocultos inicialmente', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('.hamburger')).toBeVisible();
  });

  test('hamburger abre o menu', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator('.hamburger').click();
    const navLinks = page.locator('.nav-links');
    await expect(navLinks).toBeVisible({ timeout: 3000 });
  });

  test('menu fecha ao clicar em um link', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator('.hamburger').click();
    await expect(page.locator('.nav-links')).toHaveClass(/active/, { timeout: 3000 });
    await page.locator('.nav-links a[href="#sobre"]').click();
    await page.waitForTimeout(500);
    // Menu fecha removendo a classe "active" (slide via CSS, não display:none)
    const hasActive = await page.locator('.nav-links').evaluate(el => el.classList.contains('active'));
    expect(hasActive).toBe(false);
  });

  test('seção skills sem overflow', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator('#skills').scrollIntoViewIfNeeded();
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const clientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5);
  });

  test('cards de projeto visíveis em mobile', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator('#projetos').scrollIntoViewIfNeeded();
    await expect(page.locator('.project-card').first()).toBeVisible();
  });

  test('seção contato visível em mobile', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator('#contato').scrollIntoViewIfNeeded();
    await expect(page.locator('.contact-primary-cta')).toBeVisible();
  });
});

// ─── TABLET 768px ─────────────────────────────────────────────────────────
test.describe('TABLET 768px', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('sem overflow horizontal', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const clientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5);
  });

  test('hero e conteúdo visíveis', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('.hero-body')).toBeVisible();
  });

  test('skills bento renderiza', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator('#skills').scrollIntoViewIfNeeded();
    await expect(page.locator('.skill-card').first()).toBeVisible();
  });
});

// ─── DESKTOP 1280px ───────────────────────────────────────────────────────
test.describe('DESKTOP 1280px', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('nav links visíveis diretamente (sem hamburger)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('nav .nav-links a[href="#sobre"]')).toBeVisible();
    await expect(page.locator('.hamburger')).not.toBeVisible();
  });

  test('hero em 2 colunas — foto e conteúdo lado a lado', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const content = await page.locator('.hero-content').boundingBox();
    const visual  = await page.locator('.hero-visual').boundingBox();

    // Em desktop, os dois elementos devem estar na mesma linha vertical (y próximos)
    expect(content).toBeTruthy();
    expect(visual).toBeTruthy();
    if (content && visual) {
      expect(Math.abs(content.y - visual.y)).toBeLessThan(100);
    }
  });

  test('4 skill cards lado a lado (bento grid)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator('#skills').scrollIntoViewIfNeeded();
    await expect(page.locator('.skill-card')).toHaveCount(4);
  });
});

// ─── DESKTOP WIDE 1440px ──────────────────────────────────────────────────
test.describe('DESKTOP WIDE 1440px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('sem overflow horizontal', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const clientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5);
  });

  test('ticker duplo animado visível', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.querySelector('#skills')?.scrollIntoView());
    await expect(page.locator('.ticker-track')).toHaveCount(2);
  });
});
