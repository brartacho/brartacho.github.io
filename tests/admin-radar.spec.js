const { test, expect } = require('@playwright/test');

// Radar de Vagas — descoberta + pontuação + promoção para Gestão de Vagas.
// Cada teste cria leads descartáveis e limpa ao final.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const HAS_CREDS   = Boolean(ADMIN_EMAIL && ADMIN_PASS);

let _adminJwt = null;

test.describe('ADMIN — Radar de Vagas', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD para rodar');

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const pg  = await ctx.newPage();
    await pg.goto('/admin', { waitUntil: 'networkidle' });
    await pg.locator('#loginUsername').fill(ADMIN_EMAIL);
    await pg.locator('#loginPassword').fill(ADMIN_PASS);
    await pg.locator('#loginBtn').click();
    await pg.waitForSelector('.app-logout', { state: 'visible', timeout: 12000 }).catch(() => {});
    _adminJwt = await pg.evaluate(() => sessionStorage.getItem('admin_jwt'));
    await ctx.close();
  });

  test.beforeEach(async ({ page }) => {
    if (_adminJwt) await page.addInitScript((jwt) => sessionStorage.setItem('admin_jwt', jwt), _adminJwt);
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.waitForSelector('.app-logout', { state: 'visible', timeout: 10000 }).catch(() => {});
    await page.locator('.tab-btn[data-tab="radar"]').click();
    await expect(page.locator('#tab-radar')).toBeVisible();
  });

  const lead = (page, empresa) => page.locator('#radarList .radar-lead', { hasText: empresa }).first();

  async function addLead(page, empresa, { descricao = 'Vaga de QA com testes manuais, Postman e SQL.', modalidade, tipo } = {}) {
    await page.locator('#raEmpresa').fill(empresa);
    await page.locator('#raVaga').fill('Analista de QA');
    await page.locator('#raDescricao').fill(descricao);
    if (modalidade) await page.locator('#raModalidade').selectOption(modalidade);
    if (tipo)       await page.locator('#raTipo').selectOption(tipo);
    await page.locator('button', { hasText: /Adicionar ao Radar/i }).click();
    await expect(lead(page, empresa)).toBeVisible({ timeout: 5000 });
  }

  async function removeLead(page, empresa) {
    const card = lead(page, empresa);
    if (!await card.count()) return;
    await card.locator('button[title="Excluir"]').click();
    await expect(page.locator('#confirmModal')).toHaveClass(/open/, { timeout: 5000 });
    await page.evaluate(() => document.getElementById('confirmOkBtn').click());
    await expect(lead(page, empresa)).toHaveCount(0, { timeout: 5000 });
  }

  test('adicionar vaga calcula score por regras e exibe selo', async ({ page }) => {
    const empresa = `Radar_${Date.now()}`;
    await addLead(page, empresa, { modalidade: 'Remota', tipo: 'CLT' });

    const card = lead(page, empresa);
    await expect(card.locator('.radar-score')).toBeVisible();
    const score = (await card.locator('.radar-score').innerText()).trim();
    expect(Number(score)).toBeGreaterThanOrEqual(0);
    expect(Number(score)).toBeLessThanOrEqual(10);

    await removeLead(page, empresa);
  });

  test('editor de perfil abre e fecha', async ({ page }) => {
    await expect(page.locator('#radarProfileCard')).toBeHidden();
    await page.locator('button', { hasText: /^Perfil$/i }).click();
    await expect(page.locator('#radarProfileCard')).toBeVisible();
    await page.locator('button', { hasText: /^Perfil$/i }).click();
    await expect(page.locator('#radarProfileCard')).toBeHidden();
  });

  test('análise manual: abre prompt, cola JSON e grava avaliação', async ({ page }) => {
    const empresa = `RadarAnalise_${Date.now()}`;
    await addLead(page, empresa);

    await lead(page, empresa).locator('button', { hasText: /Analisar/i }).click();
    // Sem chave de IA → modo manual abre o modal com o prompt
    await expect(page.locator('#radarAnalysisModal')).toHaveClass(/open/, { timeout: 8000 });
    await expect(page.locator('#radarPromptText')).not.toBeEmpty();

    await page.locator('#radarAnalysisJson').fill(JSON.stringify({
      fit_score: 9, required_keywords: ['QA', 'Postman'], nice_to_have_keywords: ['Playwright'],
      gaps: ['Cypress'], positioning: 'Forte aderência ao perfil.',
    }));
    await page.locator('button', { hasText: /Salvar análise/i }).click();

    const card = lead(page, empresa);
    await expect(card.locator('.radar-status-tag.s-avaliada')).toBeVisible({ timeout: 5000 });
    await expect(card.locator('.radar-score')).toHaveText('9');

    await removeLead(page, empresa);
  });

  test('promover cria candidatura em Gestão de Vagas', async ({ page }) => {
    const empresa = `RadarPromo_${Date.now()}`;
    await addLead(page, empresa, { modalidade: 'Remota' });

    await lead(page, empresa).locator('button', { hasText: /Promover/i }).click();
    await expect(page.locator('#confirmModal')).toHaveClass(/open/, { timeout: 5000 });
    await page.evaluate(() => document.getElementById('confirmOkBtn').click());
    await expect(page.locator('#toast.show')).toContainText(/Promovido/i, { timeout: 5000 });

    // Confirma na Gestão de Vagas
    await page.locator('.tab-btn[data-tab="vagas"]').click();
    await expect(page.locator('.vagas-table', { hasText: empresa })).toBeVisible({ timeout: 6000 });

    // Cleanup: deleta a candidatura promovida
    await page.locator('.vagas-table tr', { hasText: empresa }).first().click();
    await expect(page.locator('#vagasDrawer.open')).toBeVisible();
    await page.locator('#drawerBody .btn-danger').click();
    await expect(page.locator('#confirmModal')).toHaveClass(/open/, { timeout: 5000 });
    await page.evaluate(() => document.getElementById('confirmOkBtn').click());

    // Cleanup: deleta o lead do Radar
    await page.locator('.tab-btn[data-tab="radar"]').click();
    await page.locator('#radarShowAll').check();
    await removeLead(page, empresa);
  });

  test('descartar lead com motivo remove da lista ativa', async ({ page }) => {
    const empresa = `RadarDesc_${Date.now()}`;
    await addLead(page, empresa);

    await lead(page, empresa).locator('button', { hasText: /Descartar/i }).click();
    await expect(page.locator('#promptModal')).toHaveClass(/open/, { timeout: 5000 });
    await page.locator('#promptInput').fill('Senioridade incompatível');
    await page.evaluate(() => document.getElementById('promptOkBtn').click());

    await expect(page.locator('#toast.show')).toContainText(/descartado/i, { timeout: 5000 });
    await expect(lead(page, empresa)).toHaveCount(0); // some da lista ativa

    // Cleanup
    await page.locator('#radarShowAll').check();
    await removeLead(page, empresa);
  });
});
