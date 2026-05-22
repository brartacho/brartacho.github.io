import { test, expect } from '@playwright/test';

test.describe('ROTA /cv', () => {
  test('carrega sem erros', async ({ page }) => {
    const response = await page.goto('/cv', { waitUntil: 'networkidle' });
    expect(response.status()).toBe(200);
  });

  test('título contém "Currículo" ou "CV"', async ({ page }) => {
    await page.goto('/cv', { waitUntil: 'networkidle' });
    const title = await page.title();
    expect(title.toLowerCase()).toMatch(/curr[íi]culo|cv|artacho/i);
  });

  test('tem conteúdo relevante', async ({ page }) => {
    await page.goto('/cv', { waitUntil: 'networkidle' });
    const body = page.locator('body');
    // Sem token: página mostra estado de "enviado sob solicitação"
    await expect(body).toContainText('Currículo');
    await expect(body).not.toContainText('404');
    await expect(body).not.toContainText('NOT_FOUND');
  });

  test('página dinâmica carrega e mostra conteúdo de CV', async ({ page }) => {
    await page.goto('/cv', { waitUntil: 'networkidle' });
    // Sem token: exibe estado "enviado sob solicitação" com opções de contato
    await expect(page.locator('body')).not.toContainText('NOT_FOUND');
    await expect(page.locator('body')).not.toContainText('Error: Forbidden');
    await expect(page.locator('body')).toContainText('solicitação');
  });

  test('sem token mostra link de volta ao portfólio', async ({ page }) => {
    await page.goto('/cv', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000); // aguarda JS processar resposta da API
    const backLink = page.locator('a.cv-back, a[href="/"]').first();
    await expect(backLink).toBeVisible({ timeout: 10000 });
  });
});

test.describe('ROTA /estudo-caso-pagamentos.html', () => {
  test('carrega com status 200', async ({ page }) => {
    const response = await page.goto('/estudo-caso-pagamentos.html', { waitUntil: 'networkidle' });
    expect(response.status()).toBe(200);
  });

  test('tem heading principal visível', async ({ page }) => {
    await page.goto('/estudo-caso-pagamentos.html', { waitUntil: 'networkidle' });
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });

  test('contém conteúdo de QA', async ({ page }) => {
    await page.goto('/estudo-caso-pagamentos.html', { waitUntil: 'networkidle' });
    const body = page.locator('body');
    await expect(body).not.toContainText('404');
    await expect(body).toContainText('Pagamento');
  });

  test('tem link de volta para o portfólio', async ({ page }) => {
    await page.goto('/estudo-caso-pagamentos.html', { waitUntil: 'networkidle' });
    const backLink = page.locator('a[href="index.html#home"], a[href="/"], a[href="https://artacho.dev"]').first();
    await expect(backLink).toBeVisible();
  });
});

test.describe('ROTA /cenario-tecnico-qa.html', () => {
  test('carrega com status 200', async ({ page }) => {
    const response = await page.goto('/cenario-tecnico-qa.html', { waitUntil: 'networkidle' });
    expect(response.status()).toBe(200);
  });

  test('tem heading principal visível', async ({ page }) => {
    await page.goto('/cenario-tecnico-qa.html', { waitUntil: 'networkidle' });
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });

  test('contém conteúdo de API ou integração', async ({ page }) => {
    await page.goto('/cenario-tecnico-qa.html', { waitUntil: 'networkidle' });
    const body = page.locator('body');
    await expect(body).not.toContainText('404');
    await expect(body).toContainText(/API|integra[cç]|QA/i);
  });

  test('tem link de volta para o portfólio', async ({ page }) => {
    await page.goto('/cenario-tecnico-qa.html', { waitUntil: 'networkidle' });
    const backLink = page.locator('a[href="index.html#home"], a[href="/"], a[href="https://artacho.dev"]').first();
    await expect(backLink).toBeVisible();
  });
});

test.describe('ROTAS inexistentes — 404', () => {
  test('/pagina-que-nao-existe retorna erro', async ({ page }) => {
    const response = await page.goto('/pagina-que-nao-existe', { waitUntil: 'networkidle' });
    expect([404, 200]).toContain(response.status()); // 200 se Vercel servir fallback
    if (response.status() === 200) {
      await expect(page.locator('body')).toContainText(/404|not found|não encontrado/i);
    }
  });

  test('/admin/pagina-inexistente retorna 404', async ({ page }) => {
    const response = await page.goto('/admin/pagina-inexistente', { waitUntil: 'networkidle' });
    expect([404]).toContain(response.status());
  });
});
