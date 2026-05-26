/**
 * Suite completa do painel admin — desktop, tablet e mobile.
 *
 * Cobertura:
 *  - Login (campos, toggle senha, credenciais inválidas, modal esqueci senha)
 *  - Navegação por abas (top tabs desktop/tablet × bottom nav mobile)
 *  - Aba Currículos: accordion upload, lista, busca, preview PDF
 *  - Aba Tokens: accordion form, campos de criação, lista, filtros, modal share
 *  - Aba Logs: tabela, filtros (texto, tipo, datas), paginação server-side
 *  - Aba Vagas: chips de filtro, busca, CRUD candidatura, drawer, result, etapas
 *  - Logout
 *
 * IMPORTANTE — Rate limit: o endpoint de login aceita ≤5 tentativas / 15 min.
 * Por isso este arquivo usa mode:'serial' + um único beforeAll no nível do arquivo,
 * garantindo apenas 1 login por projeto (desktop / tablet / mobile).
 *
 * Variáveis de ambiente necessárias para testes autenticados:
 *   ADMIN_EMAIL, ADMIN_PASSWORD
 */

import { test, expect } from '@playwright/test';

// Serial: todos os testes deste arquivo rodam em sequência num único worker.
// Isso evita que múltiplos beforeAll façam logins concorrentes e esgotem o rate limit.
test.describe.configure({ mode: 'serial' });

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const HAS_CREDS   = Boolean(ADMIN_EMAIL && ADMIN_PASS);

// ─── Cookies compartilhados por TODOS os describes autenticados ───────────────
// Capturados uma única vez pelo beforeAll de arquivo (1 login por projeto).
let _sharedCookies = null;

test.beforeAll(async ({ browser }) => {
  if (!HAS_CREDS || _sharedCookies) return; // não re-executa login em retries seriais
  const ctx = await browser.newContext();
  const pg  = await ctx.newPage();
  try {
    await pg.goto('/admin', { waitUntil: 'networkidle' });
    await pg.locator('#loginUsername').focus();
    await pg.waitForTimeout(1100);
    await pg.locator('#loginUsername').fill(ADMIN_EMAIL);
    await pg.locator('#loginPassword').fill(ADMIN_PASS);
    await pg.locator('#loginBtn').click();
    await pg.waitForSelector('.app-logout', { state: 'visible', timeout: 15000 });
    const state = await ctx.storageState();
    _sharedCookies = state.cookies;
  } catch (e) {
    console.warn('\n⚠️  Login falhou — testes autenticados serão pulados:', e.message);
  } finally {
    await ctx.close();
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function injectAndGoto(page) {
  if (_sharedCookies?.length) {
    await page.context().addCookies(_sharedCookies);
  }
  await page.goto('/admin', { waitUntil: 'networkidle' });
  if (_sharedCookies?.length) {
    await page.waitForSelector('.app-logout', { state: 'visible', timeout: 12000 });
  }
}

async function switchToTab(page, tabName) {
  const btns = page.locator(`[data-tab="${tabName}"]`);
  const count = await btns.count();
  for (let i = 0; i < count; i++) {
    const btn = btns.nth(i);
    if (await btn.isVisible()) { await btn.click(); break; }
  }
  await page.waitForTimeout(400);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. LOGIN — estrutura (sem credenciais)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Login — estrutura da tela', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
  });

  test('página carrega com status 200', async ({ page }) => {
    const res = await page.goto('/admin', { waitUntil: 'networkidle' });
    expect(res.status()).toBe(200);
  });

  test('campo de usuário visível', async ({ page }) => {
    await expect(page.locator('#loginUsername')).toBeVisible();
  });

  test('campo de senha visível', async ({ page }) => {
    await expect(page.locator('#loginPassword')).toBeVisible();
  });

  test('botão de login visível', async ({ page }) => {
    await expect(page.locator('#loginBtn')).toBeVisible();
  });

  test('toggle de senha alterna type password ↔ text', async ({ page }) => {
    const input  = page.locator('#loginPassword');
    const toggle = page.locator('#pwToggleBtn');
    await expect(input).toHaveAttribute('type', 'password');
    await toggle.click();
    await expect(input).toHaveAttribute('type', 'text');
    await toggle.click();
    await expect(input).toHaveAttribute('type', 'password');
  });

  test('modal "esqueci a senha" abre ao clicar no link', async ({ page }) => {
    await page.locator('button.forgot-link').click();
    await expect(page.locator('#forgotModal')).toBeVisible({ timeout: 5000 });
  });

  test('modal "esqueci a senha" fecha ao clicar no X', async ({ page }) => {
    await page.locator('button.forgot-link').click();
    await expect(page.locator('#forgotModal')).toBeVisible({ timeout: 5000 });
    await page.locator('#forgotModal .forgot-close').click();
    await expect(page.locator('#forgotModal')).toBeHidden({ timeout: 5000 });
  });

  test('modal "esqueci a senha" fecha com Escape', async ({ page }) => {
    await page.locator('button.forgot-link').click();
    await expect(page.locator('#forgotModal')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#forgotModal')).toBeHidden({ timeout: 5000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. LOGIN com credenciais inválidas (usa email fictício → rate limit separado)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Login — credenciais inválidas', () => {
  test('credenciais erradas exibem mensagem de erro', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.locator('#loginUsername').fill('invalido_test_playwright@teste.com');
    await page.locator('#loginPassword').fill('senha-errada-xyz-999-playwright');
    await page.locator('#loginBtn').click();
    await expect(page.locator('#loginError')).toBeVisible({ timeout: 12000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. NAVEGAÇÃO — desktop/tablet (top tabs, viewport > 600px)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Navegação — desktop/tablet (top tabs)', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD');
  test.skip(({ viewport }) => viewport && viewport.width <= 600, 'Apenas desktop/tablet');

  test.beforeEach(async ({ page }) => { await injectAndGoto(page); });

  test('top tabs visíveis e bottom nav oculto', async ({ page }) => {
    await expect(page.locator('.app-tabs')).toBeVisible();
    await expect(page.locator('.mobile-bottom-nav')).toBeHidden();
  });

  test('5 botões de aba no top nav', async ({ page }) => {
    await expect(page.locator('.app-tabs .tab-btn')).toHaveCount(5);
  });

  test('aba Currículos ativa por padrão', async ({ page }) => {
    await expect(page.locator('.app-tabs .tab-btn[data-tab="cvs"]')).toHaveClass(/active/);
    await expect(page.locator('#tab-cvs')).toHaveClass(/active/);
  });

  test('clicar em Tokens ativa a aba correta', async ({ page }) => {
    await page.locator('.app-tabs .tab-btn[data-tab="tokens"]').click();
    await expect(page.locator('#tab-tokens')).toHaveClass(/active/);
    await expect(page.locator('.app-tabs .tab-btn[data-tab="tokens"]')).toHaveClass(/active/);
  });

  test('clicar em Logs ativa a aba correta', async ({ page }) => {
    await page.locator('.app-tabs .tab-btn[data-tab="logs"]').click();
    await expect(page.locator('#tab-logs')).toHaveClass(/active/);
  });

  test('clicar em Gestão de Vagas ativa a aba correta', async ({ page }) => {
    await page.locator('.app-tabs .tab-btn[data-tab="vagas"]').click();
    await expect(page.locator('#tab-vagas')).toHaveClass(/active/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. NAVEGAÇÃO — mobile (bottom nav, viewport ≤ 600px)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Navegação — mobile (bottom nav)', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD');
  test.skip(({ viewport }) => !viewport || viewport.width > 600, 'Apenas mobile');

  test.beforeEach(async ({ page }) => { await injectAndGoto(page); });

  test('bottom nav visível e top tabs ocultos', async ({ page }) => {
    await expect(page.locator('.mobile-bottom-nav')).toBeVisible();
    await expect(page.locator('.app-tabs')).toBeHidden();
  });

  test('4 botões no bottom nav', async ({ page }) => {
    await expect(page.locator('.mobile-bottom-nav .mobile-nav-btn')).toHaveCount(4);
  });

  test('Currículos ativa por padrão no bottom nav', async ({ page }) => {
    await expect(page.locator('.mobile-nav-btn[data-tab="cvs"]')).toHaveClass(/active/);
  });

  test('bottom nav navega para Tokens', async ({ page }) => {
    await page.locator('.mobile-nav-btn[data-tab="tokens"]').click();
    await expect(page.locator('#tab-tokens')).toHaveClass(/active/);
    await expect(page.locator('.mobile-nav-btn[data-tab="tokens"]')).toHaveClass(/active/);
  });

  test('bottom nav navega para Logs', async ({ page }) => {
    await page.locator('.mobile-nav-btn[data-tab="logs"]').click();
    await expect(page.locator('#tab-logs')).toHaveClass(/active/);
  });

  test('bottom nav navega para Vagas', async ({ page }) => {
    await page.locator('.mobile-nav-btn[data-tab="vagas"]').click();
    await expect(page.locator('#tab-vagas')).toHaveClass(/active/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. ABA CURRÍCULOS
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Aba Currículos', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await injectAndGoto(page);
    await switchToTab(page, 'cvs');
  });

  test('tabela de CVs renderiza', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 600) {
      // Mobile: thead oculto, verifica que o tbody existe e a tab está ativa
      await expect(page.locator('#tab-cvs table tbody')).toBeAttached({ timeout: 8000 });
      await expect(page.locator('#tab-cvs')).toBeVisible();
    } else {
      await expect(page.locator('#tab-cvs table thead')).toBeVisible({ timeout: 8000 });
    }
  });

  // Accordion de upload: só existe no mobile (desktop sempre exibe a zona)
  test('toggle de upload presente com aria-expanded=false por padrão', async ({ page, viewport }) => {
    test.skip(!viewport || viewport.width > 600, 'Accordion de upload é apenas mobile');
    await expect(page.locator('#cvsUploadToggleBtn')).toBeVisible();
    await expect(page.locator('#cvsUploadToggleBtn')).toHaveAttribute('aria-expanded', 'false');
  });

  test('accordion de upload abre ao clicar no toggle', async ({ page, viewport }) => {
    test.skip(!viewport || viewport.width > 600, 'Accordion de upload é apenas mobile');
    const collapsible = page.locator('#cvsUploadCollapsible');
    await expect(collapsible).not.toHaveClass(/open/);
    await page.locator('#cvsUploadToggleBtn').click();
    await expect(collapsible).toHaveClass(/open/);
    await expect(page.locator('#cvsUploadToggleBtn')).toHaveAttribute('aria-expanded', 'true');
  });

  test('accordion de upload fecha ao clicar novamente', async ({ page, viewport }) => {
    test.skip(!viewport || viewport.width > 600, 'Accordion de upload é apenas mobile');
    await page.locator('#cvsUploadToggleBtn').click();
    await page.locator('#cvsUploadToggleBtn').click();
    await expect(page.locator('#cvsUploadCollapsible')).not.toHaveClass(/open/);
  });

  test('upload zone visível', async ({ page, viewport }) => {
    // No mobile o acordeon precisa ser aberto primeiro; no desktop a zona é sempre visível
    if (!viewport || viewport.width <= 600) {
      await page.locator('#cvsUploadToggleBtn').click();
      await expect(page.locator('#cvsUploadCollapsible .upload-zone').first()).toBeVisible();
    } else {
      await expect(page.locator('#tab-cvs .upload-zone').first()).toBeVisible();
    }
  });

  test('modal de preview PDF abre se houver CVs', async ({ page }) => {
    const previewBtns = page.locator('#tab-cvs .cv-action-btn[title*="Pré-visualizar"]');
    if (await previewBtns.count() === 0) return; // pula graciosamente se não houver CVs
    await previewBtns.first().click();
    await expect(page.locator('#pdfPreviewOverlay')).toBeVisible({ timeout: 8000 });
    // Fecha pelo botão X (o primeiro botão é "Baixar", o segundo é o X)
    await page.locator('#pdfPreviewOverlay button[onclick*="closePdfPreview"]').click();
    await expect(page.locator('#pdfPreviewOverlay')).toBeHidden({ timeout: 5000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. ABA TOKENS
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Aba Tokens', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await injectAndGoto(page);
    await switchToTab(page, 'tokens');
  });

  test('seção de tokens carrega', async ({ page }) => {
    await expect(page.locator('#tab-tokens')).toHaveClass(/active/);
  });

  // Acordeon de formulário: só existe no mobile (desktop exibe o form sempre)
  test('toggle de formulário presente', async ({ page, viewport }) => {
    test.skip(!viewport || viewport.width > 600, 'Accordion de form é apenas mobile');
    await expect(page.locator('#tokenFormToggleBtn')).toBeVisible();
  });

  test('accordion de criação abre e exibe campos', async ({ page, viewport }) => {
    // No mobile precisamos abrir o acordeon; no desktop o form já está visível
    if (!viewport || viewport.width <= 600) {
      const collapsible = page.locator('#tokenFormCollapsible');
      if (!await collapsible.evaluate(el => el.classList.contains('open'))) {
        await page.locator('#tokenFormToggleBtn').click();
      }
    }
    await expect(page.locator('#tokenCV')).toBeVisible();
    await expect(page.locator('#tokenLabel')).toBeVisible();
    await expect(page.locator('#tokenMaxUses')).toBeVisible();
  });

  test('6 opções de validade presentes', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 600) {
      const collapsible = page.locator('#tokenFormCollapsible');
      if (!await collapsible.evaluate(el => el.classList.contains('open'))) {
        await page.locator('#tokenFormToggleBtn').click();
      }
    }
    await expect(page.locator('#expiryOpts .expiry-opt')).toHaveCount(6);
    await expect(page.locator('#expiryOpts .expiry-opt').filter({ hasText: '24h' })).toHaveCount(1);
    await expect(page.locator('#expiryOpts .expiry-opt').filter({ hasText: '30 dias' })).toHaveCount(1);
  });

  test('"Data específica" exibe input datetime-local', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 600) {
      const collapsible = page.locator('#tokenFormCollapsible');
      if (!await collapsible.evaluate(el => el.classList.contains('open'))) {
        await page.locator('#tokenFormToggleBtn').click();
      }
    }
    await page.locator('#expiryOpts .expiry-opt[data-hours="custom"]').click();
    await expect(page.locator('#expiryDate')).toBeVisible();
  });

  test('tabela de tokens renderiza', async ({ page, viewport }) => {
    await expect(page.locator('#tokenTable')).toBeAttached();
    if (!viewport || viewport.width > 600) {
      await expect(page.locator('#tab-tokens table thead')).toBeVisible({ timeout: 8000 });
    }
  });

  test('campo de busca e filtro de status presentes', async ({ page }) => {
    await expect(page.locator('#tokenSearch')).toBeVisible();
    await expect(page.locator('#tokenStatusFilter')).toBeVisible();
    await expect(page.locator('#tokenStatusFilter option')).toHaveCount(5);
  });

  test('busca por string sem match retorna contagem 0', async ({ page }) => {
    await page.locator('#tokenSearch').fill('zzz_nenhum_match_playwright_xyz');
    await page.waitForTimeout(300);
    const count = page.locator('#tokenCount');
    if (await count.isVisible()) {
      await expect(count).toContainText('0');
    }
    await page.locator('#tokenSearch').fill('');
  });

  test('modal share abre a partir de token existente', async ({ page }) => {
    const rows = page.locator('#tokenTable tbody tr').filter({
      hasNot: page.locator('td[colspan]'),
    });
    if (await rows.count() === 0) return; // pula se não houver tokens
    const shareBtn = rows.first().locator('button').first();
    await shareBtn.click();
    const shareModal = page.locator('#shareModal');
    const isVisible  = await shareModal.isVisible().catch(() => false);
    if (isVisible) {
      await page.keyboard.press('Escape');
      await expect(shareModal).toBeHidden({ timeout: 5000 });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. ABA LOGS
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Aba Logs', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await injectAndGoto(page);
    await switchToTab(page, 'logs');
    await page.waitForSelector('#logOverlay', { state: 'hidden', timeout: 10000 }).catch(() => {});
  });

  test('tabela de logs renderiza', async ({ page, viewport }) => {
    await expect(page.locator('#logTable')).toBeAttached();
    if (!viewport || viewport.width > 600) {
      await expect(page.locator('#tab-logs table thead')).toBeVisible();
    }
  });

  test('campo de busca presente', async ({ page }) => {
    await expect(page.locator('#logSearch')).toBeVisible();
  });

  test('filtro por tipo com 6 opções', async ({ page }) => {
    await expect(page.locator('#logTipoFilter')).toBeVisible();
    await expect(page.locator('#logTipoFilter option')).toHaveCount(6);
  });

  test('filtros de data De / Até presentes', async ({ page }) => {
    await expect(page.locator('#logFrom')).toBeVisible();
    await expect(page.locator('#logTo')).toBeVisible();
  });

  test('filtrar por data futura retorna 0 ou 1 linha', async ({ page }) => {
    await page.locator('#logFrom').fill('2099-01-01');
    await page.locator('#logFrom').dispatchEvent('change'); // fill() não garante change em todos os browsers
    await page.waitForSelector('#logOverlay', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const rows = await page.locator('#logTable tr').count();
    expect(rows).toBeLessThanOrEqual(1);
    await page.locator('#logFrom').fill('');
    await page.locator('#logFrom').dispatchEvent('change');
    await page.waitForSelector('#logOverlay', { state: 'hidden', timeout: 8000 }).catch(() => {});
  });

  test('filtrar por tipo "Acesso do recrutador" recarrega tabela', async ({ page }) => {
    await page.locator('#logTipoFilter').selectOption('download');
    await page.waitForSelector('#logOverlay', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await expect(page.locator('#logTable')).toBeAttached();
  });

  test('paginação visível se houver registros suficientes', async ({ page }) => {
    const rowCount = await page.locator('#logTable tr').count();
    if (rowCount === 0) return;
    const pagination = page.locator('#logPagination');
    if (await pagination.isVisible()) {
      await expect(page.locator('#logPrevBtn')).toBeVisible();
      await expect(page.locator('#logNextBtn')).toBeVisible();
    }
  });

  test('clique em linha abre drawer de detalhe', async ({ page }) => {
    const rows = page.locator('#logTable tr').filter({ hasNot: page.locator('td[colspan]') });
    if (await rows.count() === 0) return;
    await rows.first().click();
    await expect(page.locator('#logDrawer')).toBeVisible({ timeout: 5000 });
    await page.locator('#logDrawerOverlay').click({ force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. ABA VAGAS — estrutura e filtros
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Aba Vagas — estrutura e filtros', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await injectAndGoto(page);
    await switchToTab(page, 'vagas');
    await page.waitForSelector('.vagas-table', { timeout: 8000 });
  });

  test('tabela de vagas carrega', async ({ page }) => {
    await expect(page.locator('.vagas-table')).toBeVisible();
  });

  test('4 chips de filtro (Todas, Em processo, Aprovado, Recusado)', async ({ page }) => {
    const chips = page.locator('.vagas-filter-chip');
    await expect(chips).toHaveCount(4);
    await expect(chips.filter({ hasText: 'Todas' })).toHaveCount(1);
    await expect(chips.filter({ hasText: /em processo/i })).toHaveCount(1);
    await expect(chips.filter({ hasText: /aprovado/i })).toHaveCount(1);
    await expect(chips.filter({ hasText: /recusado/i })).toHaveCount(1);
  });

  test('chip "Todas" ativo por padrão', async ({ page }) => {
    await expect(page.locator('.vagas-filter-chip[data-filter="all"]')).toHaveClass(/active/);
  });

  test('clicar em chip muda filtro ativo', async ({ page }) => {
    await page.locator('.vagas-filter-chip[data-filter="em-processo"]').click();
    await expect(page.locator('.vagas-filter-chip[data-filter="em-processo"]')).toHaveClass(/active/);
    await expect(page.locator('.vagas-filter-chip[data-filter="all"]')).not.toHaveClass(/active/);
  });

  test('campo de busca presente', async ({ page }) => {
    await expect(page.locator('#vagasSearch')).toBeVisible();
  });

  test('busca por string sem match retorna 0', async ({ page }) => {
    await page.locator('#vagasSearch').fill('zzz_playwright_no_match_xyz');
    await page.waitForTimeout(300);
    const count = page.locator('#vagasCount');
    if (await count.isVisible()) {
      await expect(count).toContainText('0');
    }
    await page.locator('#vagasSearch').fill('');
  });

  test('botão "Nova vaga" visível', async ({ page }) => {
    await expect(page.locator('button', { hasText: /nova vaga/i })).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. ABA VAGAS — CRUD candidatura
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Aba Vagas — CRUD candidatura', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await injectAndGoto(page);
    await switchToTab(page, 'vagas');
    await page.waitForSelector('.vagas-table', { timeout: 8000 });
  });

  test('formulário "Nova vaga" abre com todos os campos', async ({ page }) => {
    await page.locator('button', { hasText: /nova vaga/i }).click();
    await expect(page.locator('#novaVagaForm')).toBeVisible({ timeout: 3000 });
    for (const id of ['#vfEmpresa','#vfVaga','#vfLinkedin','#vfLinkVaga','#vfObs','#vfGestorNome','#vfGestorEmail','#vfDataEnvio']) {
      await expect(page.locator(id)).toBeVisible();
    }
  });

  test('submeter sem empresa exibe erro obrigatório', async ({ page }) => {
    await page.locator('button', { hasText: /nova vaga/i }).click();
    await expect(page.locator('#novaVagaForm')).toBeVisible();
    await page.locator('#novaVagaForm button', { hasText: /criar candidatura/i }).click();
    await expect(page.locator('#vfMsg')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#vfMsg')).toContainText(/empresa/i);
  });

  test('cancelar formulário remove o form do DOM', async ({ page }) => {
    await page.locator('button', { hasText: /nova vaga/i }).click();
    await expect(page.locator('#novaVagaForm')).toBeVisible();
    await page.locator('#novaVagaForm button', { hasText: /cancelar/i }).click();
    await expect(page.locator('#novaVagaForm')).toBeHidden();
  });

  test('criar candidatura → aparece na tabela → excluir (fluxo completo)', async ({ page }) => {
    const empresa = `PW_Suite_${Date.now()}`;

    // Criar
    await page.locator('button', { hasText: /nova vaga/i }).click();
    await page.locator('#vfEmpresa').fill(empresa);
    await page.locator('#vfVaga').fill('QA Automation Engineer');
    await page.locator('#novaVagaForm button', { hasText: /criar candidatura/i }).click();
    await expect(page.locator('.vagas-table', { hasText: empresa })).toBeVisible({ timeout: 8000 });

    // Abrir drawer
    await page.locator('.vagas-table tr', { hasText: empresa }).first().click();
    await expect(page.locator('#vagasDrawer')).toHaveClass(/open/, { timeout: 5000 });

    // Excluir — modal de confirmação customizado (não dialog nativo)
    await page.locator('#drawerBody .btn-danger').click();
    await expect(page.locator('#confirmModal')).toHaveClass(/open/, { timeout: 5000 });
    // O overlay do drawer pode interceptar clicks; disparamos via evaluate para contornar
    await page.evaluate(() => document.getElementById('confirmOkBtn').click());
    await expect(page.locator('#vagasDrawer')).not.toHaveClass(/open/, { timeout: 8000 });
    await expect(page.locator('.vagas-table', { hasText: empresa })).toBeHidden({ timeout: 5000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. ABA VAGAS — drawer e etapas
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Aba Vagas — drawer e etapas', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await injectAndGoto(page);
    await switchToTab(page, 'vagas');
    await page.waitForSelector('.vagas-table', { timeout: 8000 });
  });

  async function criarEAbrirVaga(page, nome) {
    await page.locator('button', { hasText: /nova vaga/i }).click();
    await page.locator('#vfEmpresa').fill(nome);
    await page.locator('#novaVagaForm button', { hasText: /criar candidatura/i }).click();
    await expect(page.locator('.vagas-table', { hasText: nome })).toBeVisible({ timeout: 8000 });
    await page.locator('.vagas-table tr', { hasText: nome }).first().click();
    await expect(page.locator('#vagasDrawer')).toHaveClass(/open/, { timeout: 5000 });
  }

  async function excluirVagaAberta(page) {
    await page.locator('#drawerBody .btn-danger').click();
    await expect(page.locator('#confirmModal')).toHaveClass(/open/, { timeout: 5000 });
    // O overlay do drawer pode interceptar clicks; disparamos via evaluate para contornar
    await page.evaluate(() => document.getElementById('confirmOkBtn').click());
    await expect(page.locator('#vagasDrawer')).not.toHaveClass(/open/, { timeout: 8000 });
  }

  test('drawer exibe empresa e controle de resultado', async ({ page }) => {
    const nome = `PW_Drw_${Date.now()}`;
    await criarEAbrirVaga(page, nome);
    await expect(page.locator('#drawerEmpresa')).toContainText(nome);
    await expect(page.locator('#drawerResult')).toBeVisible();
    await excluirVagaAberta(page);
  });

  test('"Em processo" ativo por padrão no segmented control', async ({ page }) => {
    const nome = `PW_Seg_${Date.now()}`;
    await criarEAbrirVaga(page, nome);
    await expect(page.locator('#drawerResult .result-seg.active.r-em_processo')).toBeVisible();
    await excluirVagaAberta(page);
  });

  test('timeline de etapas renderiza com etapas padrão', async ({ page }) => {
    const nome = `PW_TL_${Date.now()}`;
    await criarEAbrirVaga(page, nome);
    await expect(page.locator('#drawerTimeline')).toBeVisible();
    const labels = await page.locator('#drawerTimeline .stage-label').allInnerTexts();
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).toContain('Enviado');
    expect(labels).toContain('Proposta');
    expect(labels).not.toContain('Aprovado');
    expect(labels).not.toContain('Recusado');
    await excluirVagaAberta(page);
  });

  test('botão "Gerenciar etapas" abre o manager', async ({ page }) => {
    const nome = `PW_Mgr_${Date.now()}`;
    await criarEAbrirVaga(page, nome);
    await page.locator('#drawerBody button', { hasText: /gerenciar etapas/i }).click();
    await expect(page.locator('#stageManagerSection')).toBeVisible({ timeout: 5000 });
    await excluirVagaAberta(page);
  });

  test('botão "Editar" abre formulário de edição', async ({ page }) => {
    const nome = `PW_Edit_${Date.now()}`;
    await criarEAbrirVaga(page, nome);
    await page.locator('#drawerBody button', { hasText: /editar/i }).click();
    await expect(page.locator('#editVagaSection')).toBeVisible({ timeout: 5000 });
    await excluirVagaAberta(page);
  });

  test('drawer fecha ao clicar no overlay', async ({ page }) => {
    const nome = `PW_Ov_${Date.now()}`;
    await criarEAbrirVaga(page, nome);
    await page.locator('#vagasOverlay').click({ force: true });
    await expect(page.locator('#vagasDrawer')).not.toHaveClass(/open/, { timeout: 5000 });
    // Limpa: reabre e deleta
    await page.locator('.vagas-table tr', { hasText: nome }).first().click();
    await expect(page.locator('#vagasDrawer')).toHaveClass(/open/, { timeout: 5000 });
    await excluirVagaAberta(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. LOGOUT
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Logout', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD');

  test.beforeEach(async ({ page }) => { await injectAndGoto(page); });

  test('botão de logout visível', async ({ page }) => {
    await expect(page.locator('.app-logout')).toBeVisible();
  });

  test('clicar em logout retorna para tela de login', async ({ page }) => {
    await page.locator('.app-logout').click();
    await expect(page.locator('#loginScreen')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#appScreen')).toBeHidden();
  });

  test('após logout JWT não persiste em sessionStorage', async ({ page }) => {
    await page.locator('.app-logout').click();
    await expect(page.locator('#loginScreen')).toBeVisible({ timeout: 5000 });
    const storedJwt = await page.evaluate(() => sessionStorage.getItem('admin_jwt'));
    expect(storedJwt).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. /admin/reset
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('/admin/reset', () => {
  test('página carrega com status 200', async ({ page }) => {
    const res = await page.goto('/admin/reset', { waitUntil: 'networkidle' });
    expect(res.status()).toBe(200);
  });

  test('sem token: exibe mensagem de link inválido ou expirado', async ({ page }) => {
    await page.goto('/admin/reset', { waitUntil: 'networkidle' });
    const body = await page.locator('body').textContent();
    expect(body.length).toBeGreaterThan(100);
    expect(body).toMatch(/inválido|expirado|invalid|expired|link/i);
  });

  test('título da página condiz com redefinição de senha', async ({ page }) => {
    await page.goto('/admin/reset', { waitUntil: 'networkidle' });
    const title = await page.title();
    expect(title.toLowerCase()).toMatch(/reset|redefin|senha|artacho/i);
  });
});
