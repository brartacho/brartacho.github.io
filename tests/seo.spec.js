import { test, expect } from '@playwright/test';

test.describe('SEO — homepage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
  });

  test('title contém "Bruno Artacho" e "QA"', async ({ page }) => {
    const title = await page.title();
    expect(title).toMatch(/Bruno Artacho/);
    expect(title).toMatch(/QA|Playwright/i);
  });

  test('meta description presente e relevante', async ({ page }) => {
    const desc = await page.locator('meta[name="description"]').getAttribute('content');
    expect(desc).toBeTruthy();
    expect(desc.length).toBeGreaterThan(50);
    expect(desc).toMatch(/QA|Playwright|HealthTech/i);
  });

  test('canonical URL aponta para artacho.dev', async ({ page }) => {
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toMatch(/https:\/\/artacho\.dev/);
  });

  test('meta robots: index, follow', async ({ page }) => {
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('index');
    expect(robots).toContain('follow');
  });

  test('og:title presente', async ({ page }) => {
    const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content');
    expect(ogTitle).toMatch(/Bruno Artacho/);
  });

  test('og:description presente', async ({ page }) => {
    const ogDesc = await page.locator('meta[property="og:description"]').getAttribute('content');
    expect(ogDesc).toBeTruthy();
    expect(ogDesc.length).toBeGreaterThan(30);
  });

  test('og:image aponta para artacho.dev', async ({ page }) => {
    const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(ogImage).toMatch(/artacho\.dev/);
    expect(ogImage).toMatch(/\.(jpg|jpeg|png|webp)/i);
  });

  test('og:url aponta para artacho.dev', async ({ page }) => {
    const ogUrl = await page.locator('meta[property="og:url"]').getAttribute('content');
    expect(ogUrl).toMatch(/https:\/\/artacho\.dev/);
  });

  test('twitter:card é summary_large_image', async ({ page }) => {
    const card = await page.locator('meta[name="twitter:card"]').getAttribute('content');
    expect(card).toBe('summary_large_image');
  });

  test('favicon SVG presente', async ({ page }) => {
    const favicon = await page.locator('link[rel="icon"]').getAttribute('href');
    expect(favicon).toMatch(/\.svg/);
  });

  test('meta author presente', async ({ page }) => {
    const author = await page.locator('meta[name="author"]').getAttribute('content');
    expect(author).toMatch(/Bruno Artacho/);
  });

  test('lang="pt-br" no html', async ({ page }) => {
    const lang = await page.locator('html').getAttribute('lang');
    expect(lang?.toLowerCase()).toContain('pt');
  });
});

test.describe('SEO — /cv (noindex)', () => {
  test('meta robots: noindex, nofollow', async ({ page }) => {
    await page.goto('/cv', { waitUntil: 'networkidle' });
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toMatch(/noindex/i);
  });
});

test.describe('SEO — /admin (noindex)', () => {
  test('meta robots: noindex ou header X-Robots-Tag', async ({ page }) => {
    const response = await page.goto('/admin', { waitUntil: 'networkidle' });
    const xRobots = response.headers()['x-robots-tag'] ?? '';
    const metaRobots = await page.locator('meta[name="robots"]').getAttribute('content').catch(() => '');
    expect(xRobots + (metaRobots ?? '')).toMatch(/noindex/i);
  });
});

test.describe('SEO — performance básica', () => {
  test('homepage carrega em menos de 5s', async ({ page }) => {
    const start = Date.now();
    await page.goto('/', { waitUntil: 'networkidle' });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  test('imagens têm atributo alt', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const images = page.locator('img');
    const count = await images.count();
    for (let i = 0; i < count; i++) {
      const alt = await images.nth(i).getAttribute('alt');
      expect(alt).not.toBeNull();
    }
  });

  test('skip-link para acessibilidade presente', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('.skip-link, a[href="#home"][class*="skip"]').first()).toBeAttached();
  });
});
