import { test, expect } from '@playwright/test';

// Cenários de gestão de etapas e resultado da candidatura.
// Cobre a refatoração que separou `result` (em_processo/aprovado/recusado)
// das etapas (Triagem, Entrevistas, etc.).
//
// Cada teste cria uma vaga manual descartável, exercita o fluxo, e deleta.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const HAS_CREDS   = Boolean(ADMIN_EMAIL && ADMIN_PASS);

let _adminCookies = null;

test.describe('ADMIN — Gestão de etapas', () => {
  test.skip(!HAS_CREDS, 'Defina ADMIN_EMAIL e ADMIN_PASSWORD para rodar');

  test.beforeAll(async ({ browser }) => {
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
      _adminCookies = state.cookies;
    } catch (e) {
      console.warn('\n⚠️  Login falhou — testes autenticados serão pulados:', e.message);
    } finally {
      await ctx.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    if (_adminCookies?.length) await page.context().addCookies(_adminCookies);
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.waitForSelector('.app-logout', { state: 'visible', timeout: 10000 }).catch(() => {});
    // Vai pra aba Gestão de Vagas
    await page.locator('.tab-btn').filter({ hasText: /vaga/i }).first().click();
    await expect(page.locator('.vagas-table')).toBeVisible();
  });

  async function createTempVaga(page, empresa, { modalidade, tipoContratacao, dataEnvio } = {}) {
    await page.locator('button', { hasText: /nova vaga/i }).click();
    await expect(page.locator('#novaVagaForm')).toBeVisible();
    await page.locator('#novaVagaForm input[name="empresa"], #novaVagaForm [id*="mpresa" i]').first().fill(empresa);
    if (modalidade)       await page.locator('#vfModalidade').selectOption(modalidade);
    if (tipoContratacao)  await page.locator('#vfTipoContratacao').selectOption(tipoContratacao);
    if (dataEnvio)        await page.locator('#vfDataEnvio').fill(dataEnvio);
    await page.locator('#novaVagaForm button', { hasText: /salvar|criar/i }).first().click();
    // Aguarda aparecer na tabela
    await expect(page.locator('.vagas-table', { hasText: empresa })).toBeVisible({ timeout: 5000 });
  }

  async function openVaga(page, empresa) {
    await page.locator('.vagas-table tr', { hasText: empresa }).first().click();
    await expect(page.locator('#vagasDrawer.open')).toBeVisible();
  }

  async function deleteOpenVaga(page) {
    await page.locator('#drawerBody .btn-danger').click();
    await expect(page.locator('#confirmModal')).toHaveClass(/open/, { timeout: 5000 });
    await page.evaluate(() => document.getElementById('confirmOkBtn').click());
    await expect(page.locator('#vagasDrawer')).not.toHaveClass(/open/);
  }

  test('default stages não inclui Aprovado nem Recusado', async ({ page }) => {
    const empresa = `TestVaga_${Date.now()}`;
    await createTempVaga(page, empresa);
    await openVaga(page, empresa);

    // Timeline deve mostrar 7 etapas padrão (não 9)
    const labels = await page.locator('#drawerTimeline .stage-label').allInnerTexts();
    expect(labels).not.toContain('Aprovado');
    expect(labels).not.toContain('Recusado');
    expect(labels).toContain('Enviado');
    expect(labels).toContain('Proposta');

    await deleteOpenVaga(page);
  });

  test('segmented control de Resultado aparece e Em processo ativo por padrão', async ({ page }) => {
    const empresa = `TestRes_${Date.now()}`;
    await createTempVaga(page, empresa);
    await openVaga(page, empresa);

    const seg = page.locator('#drawerResult');
    await expect(seg).toBeVisible();
    await expect(seg.locator('.result-seg.active.r-em_processo')).toBeVisible();
    await expect(seg.locator('.result-seg.active.r-aprovado')).toHaveCount(0);

    await deleteOpenVaga(page);
  });

  test('setar Resultado=Aprovado atualiza badge e filtro sem mexer em etapas', async ({ page }) => {
    const empresa = `TestApp_${Date.now()}`;
    await createTempVaga(page, empresa);
    await openVaga(page, empresa);

    // Snapshot do número de etapas com status 'running' antes
    const runningBefore = await page.locator('#drawerTimeline .stage-circle.current').count();

    // Clica em Aprovado
    await page.locator('#drawerResult .result-seg', { hasText: /aprovado/i }).click();
    await expect(page.locator('#drawerResult .result-seg.active.r-aprovado')).toBeVisible();

    // Etapas continuam intocadas
    const runningAfter = await page.locator('#drawerTimeline .stage-circle.current').count();
    expect(runningAfter).toBe(runningBefore);

    // Linha na tabela ganha o badge aprovado
    await expect(page.locator('.vagas-table .stage-badge.status-aprovado')).toBeVisible();

    await deleteOpenVaga(page);
  });

  test('setar status em etapa não cascateia para outras', async ({ page }) => {
    const empresa = `TestCascade_${Date.now()}`;
    await createTempVaga(page, empresa);
    await openVaga(page, empresa);

    // Abre o manager
    await page.locator('#drawerBody button', { hasText: /gerenciar etapas/i }).click();
    const manager = page.locator('#stageManagerSection');
    await expect(manager).toBeVisible();

    // Marca a 3ª etapa (Entrevista RH) como done (✓)
    const row3 = manager.locator('.stage-manager-row').nth(2);
    await row3.locator('.sm-status-btn[title*="Aprovado" i]').click();

    // Etapas 1 e 2 continuam intocadas (Enviado=running por default, Triagem=pending)
    const row1 = manager.locator('.stage-manager-row').nth(0);
    const row2 = manager.locator('.stage-manager-row').nth(1);
    await expect(row1.locator('.sm-status-btn.active.st-running')).toBeVisible(); // Enviado segue executando
    await expect(row2.locator('.sm-status-btn.active.st-pending')).toBeVisible(); // Triagem segue pendente
    await expect(row3.locator('.sm-status-btn.active.st-done')).toBeVisible();    // RH agora done

    await deleteOpenVaga(page);
  });

  test('modalidade e tipo de contratação salvos e exibidos no drawer e na tabela', async ({ page }) => {
    const empresa = `TestMod_${Date.now()}`;
    await createTempVaga(page, empresa, { modalidade: 'Remota', tipoContratacao: 'PJ' });

    // Badge na linha da tabela
    const row = page.locator('.vagas-table tr', { hasText: empresa }).first();
    await expect(row.locator('span', { hasText: 'Remota' })).toBeVisible();
    await expect(row.locator('span', { hasText: 'PJ' })).toBeVisible();

    // Drawer mostra os chips
    await openVaga(page, empresa);
    await expect(page.locator('#vagasDrawer .dinfo-chip', { hasText: 'Remota' })).toBeVisible();
    await expect(page.locator('#vagasDrawer .dinfo-chip', { hasText: 'PJ' })).toBeVisible();

    await deleteOpenVaga(page);
  });

  test('filtro por modalidade exibe apenas vagas correspondentes', async ({ page }) => {
    const empresaRemota  = `TRemota_${Date.now()}`;
    const empresaPresencial = `TPres_${Date.now()}`;
    await createTempVaga(page, empresaRemota,    { modalidade: 'Remota' });
    await createTempVaga(page, empresaPresencial, { modalidade: 'Presencial' });

    // Ativa filtro Remota
    await page.locator('#vagasFiltersModalidade .vagas-filter-chip', { hasText: 'Remota' }).click();
    await expect(page.locator('.vagas-table', { hasText: empresaRemota })).toBeVisible();
    await expect(page.locator('.vagas-table', { hasText: empresaPresencial })).toHaveCount(0);

    // Volta pra Todas
    await page.locator('#vagasFiltersModalidade .vagas-filter-chip', { hasText: 'Modalidade' }).click();

    // Limpa vagas de teste
    await openVaga(page, empresaRemota);
    await deleteOpenVaga(page);
    await openVaga(page, empresaPresencial);
    await deleteOpenVaga(page);
  });

  test('filtro por tipo de contratação exibe apenas vagas correspondentes', async ({ page }) => {
    const empresaCLT = `TCLT_${Date.now()}`;
    const empresaPJ  = `TPJ_${Date.now()}`;
    await createTempVaga(page, empresaCLT, { tipoContratacao: 'CLT' });
    await createTempVaga(page, empresaPJ,  { tipoContratacao: 'PJ' });

    // Ativa filtro PJ
    await page.locator('#vagasFiltersTipo .vagas-filter-chip', { hasText: 'PJ' }).click();
    await expect(page.locator('.vagas-table', { hasText: empresaPJ })).toBeVisible();
    await expect(page.locator('.vagas-table', { hasText: empresaCLT })).toHaveCount(0);

    // Volta pra Todos
    await page.locator('#vagasFiltersTipo .vagas-filter-chip', { hasText: 'Contratação' }).click();

    // Limpa vagas de teste
    await openVaga(page, empresaCLT);
    await deleteOpenVaga(page);
    await openVaga(page, empresaPJ);
    await deleteOpenVaga(page);
  });

  test('filtros combinados: Remota + PJ retorna apenas vagas com ambos os campos', async ({ page }) => {
    const empresaMatch   = `TMatch_${Date.now()}`;
    const empresaNoMatch = `TNoMatch_${Date.now()}`;
    await createTempVaga(page, empresaMatch,   { modalidade: 'Remota', tipoContratacao: 'PJ' });
    await createTempVaga(page, empresaNoMatch, { modalidade: 'Remota', tipoContratacao: 'CLT' });

    await page.locator('#vagasFiltersModalidade .vagas-filter-chip', { hasText: 'Remota' }).click();
    await page.locator('#vagasFiltersTipo .vagas-filter-chip', { hasText: 'PJ' }).click();

    await expect(page.locator('.vagas-table', { hasText: empresaMatch })).toBeVisible();
    await expect(page.locator('.vagas-table', { hasText: empresaNoMatch })).toHaveCount(0);

    // Reset filtros e limpa
    await page.locator('#vagasFiltersModalidade .vagas-filter-chip', { hasText: 'Modalidade' }).click();
    await page.locator('#vagasFiltersTipo .vagas-filter-chip', { hasText: 'Contratação' }).click();
    await openVaga(page, empresaMatch);
    await deleteOpenVaga(page);
    await openVaga(page, empresaNoMatch);
    await deleteOpenVaga(page);
  });

  test('editar vaga carrega e atualiza modalidade e tipo', async ({ page }) => {
    const empresa = `TestEdit_${Date.now()}`;
    await createTempVaga(page, empresa, { modalidade: 'Híbrida', tipoContratacao: 'CLT' });
    await openVaga(page, empresa);

    // Abre edição e altera os campos
    await page.locator('#drawerBody button', { hasText: /editar/i }).first().click();
    await expect(page.locator('#editVagaSection')).toBeVisible();
    await expect(page.locator('#vfModalidade')).toHaveValue('Híbrida');
    await expect(page.locator('#vfTipoContratacao')).toHaveValue('CLT');

    await page.locator('#vfModalidade').selectOption('Remota');
    await page.locator('#vfTipoContratacao').selectOption('PJ');
    await page.locator('#editVagaSection button', { hasText: /salvar/i }).click();

    // Drawer atualiza imediatamente
    await expect(page.locator('#vagasDrawer .dinfo-chip', { hasText: 'Remota' })).toBeVisible();
    await expect(page.locator('#vagasDrawer .dinfo-chip', { hasText: 'PJ' })).toBeVisible();

    await deleteOpenVaga(page);
  });

  test('etapa desativada (toggle off) some da timeline mas permanece no manager', async ({ page }) => {
    const empresa = `TestHide_${Date.now()}`;
    await createTempVaga(page, empresa);
    await openVaga(page, empresa);

    const labelsBefore = await page.locator('#drawerTimeline .stage-label').count();

    await page.locator('#drawerBody button', { hasText: /gerenciar etapas/i }).click();
    const manager = page.locator('#stageManagerSection');
    await expect(manager).toBeVisible();

    // Desativa "Teste Técnico" (4ª etapa)
    await manager.locator('.stage-manager-row').nth(3).locator('.stage-toggle').click();
    await expect(manager.locator('.stage-manager-row').nth(3)).toHaveClass(/inactive/);

    // Timeline perde 1 entrada
    await expect(page.locator('#drawerTimeline .stage-label')).toHaveCount(labelsBefore - 1);
    const labelsAfter = await page.locator('#drawerTimeline .stage-label').allInnerTexts();
    expect(labelsAfter).not.toContain('Teste Técnico');

    await deleteOpenVaga(page);
  });

  // ─── ARQUIVAMENTO ──────────────────────────────────────────
  test('arquivar remove vaga da listagem principal e mostra toast', async ({ page }) => {
    const empresa = `TestArq_${Date.now()}`;
    await createTempVaga(page, empresa);
    await openVaga(page, empresa);

    await page.locator('button[title="Arquivar candidatura"]').click();
    await expect(page.locator('#toast.show span')).toHaveText('Candidatura arquivada.', { timeout: 5000 });
    await expect(page.locator('#vagasDrawer.open')).toBeVisible();
    await expect(page.locator('.vagas-table', { hasText: empresa })).toHaveCount(0);

    // Cleanup via filtro Arquivadas
    await page.locator('#vagasFilters .vagas-filter-chip[data-filter="arquivadas"]').click();
    await openVaga(page, empresa);
    await deleteOpenVaga(page);
    await page.locator('#vagasFilters .vagas-filter-chip[data-filter="all"]').click();
  });

  test('badge "arquivada" aparece no drawerMeta após arquivar', async ({ page }) => {
    const empresa = `TestArqBadge_${Date.now()}`;
    await createTempVaga(page, empresa);
    await openVaga(page, empresa);

    await page.locator('button[title="Arquivar candidatura"]').click();
    await expect(page.locator('#toast.show span')).toHaveText('Candidatura arquivada.', { timeout: 5000 });
    await expect(page.locator('#drawerMeta')).toContainText('arquivada');

    await page.locator('#vagasFilters .vagas-filter-chip[data-filter="arquivadas"]').click();
    await openVaga(page, empresa);
    await deleteOpenVaga(page);
    await page.locator('#vagasFilters .vagas-filter-chip[data-filter="all"]').click();
  });

  test('chip Arquivadas: exibe arquivadas e oculta não-arquivadas', async ({ page }) => {
    const empresaAtiva = `TestChipAtiva_${Date.now()}`;
    const empresaArq   = `TestChipArq_${Date.now()}`;
    await createTempVaga(page, empresaAtiva);
    await createTempVaga(page, empresaArq);

    await openVaga(page, empresaArq);
    await page.locator('button[title="Arquivar candidatura"]').click();
    await expect(page.locator('#toast.show span')).toHaveText('Candidatura arquivada.', { timeout: 5000 });
    await page.keyboard.press('Escape');

    await page.locator('#vagasFilters .vagas-filter-chip[data-filter="arquivadas"]').click();
    await expect(page.locator('.vagas-table', { hasText: empresaArq })).toBeVisible();
    await expect(page.locator('.vagas-table', { hasText: empresaAtiva })).toHaveCount(0);

    await openVaga(page, empresaArq);
    await deleteOpenVaga(page);
    await page.locator('#vagasFilters .vagas-filter-chip[data-filter="all"]').click();
    await openVaga(page, empresaAtiva);
    await deleteOpenVaga(page);
  });

  test('desarquivar: toast correto, vaga volta ao filtro Todas', async ({ page }) => {
    const empresa = `TestDesarq_${Date.now()}`;
    await createTempVaga(page, empresa);
    await openVaga(page, empresa);

    await page.locator('button[title="Arquivar candidatura"]').click();
    await expect(page.locator('#toast.show span')).toHaveText('Candidatura arquivada.', { timeout: 5000 });

    await page.locator('#vagasFilters .vagas-filter-chip[data-filter="arquivadas"]').click();
    await openVaga(page, empresa);

    await page.locator('button[title="Desarquivar candidatura"]').click();
    await expect(page.locator('#toast.show span')).toHaveText('Candidatura desarquivada.', { timeout: 5000 });

    await page.locator('#vagasFilters .vagas-filter-chip[data-filter="all"]').click();
    await expect(page.locator('.vagas-table', { hasText: empresa })).toBeVisible();

    await openVaga(page, empresa);
    await deleteOpenVaga(page);
  });

  // ─── FILTRO DE DATAS ──────────────────────────────────────
  test('filtro De: exibe apenas vagas com data_envio >= data informada', async ({ page }) => {
    const empresaAntiga  = `TDateAntiga_${Date.now()}`;
    const empresaRecente = `TDateRecente_${Date.now()}`;
    const hoje = new Date().toISOString().slice(0, 10);

    await createTempVaga(page, empresaAntiga,  { dataEnvio: '2020-01-01' });
    await createTempVaga(page, empresaRecente, { dataEnvio: hoje });

    await page.locator('#vagasDateFrom').fill('2021-01-01');
    await page.locator('#vagasDateFrom').dispatchEvent('change');

    await expect(page.locator('.vagas-table', { hasText: empresaRecente })).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.vagas-table', { hasText: empresaAntiga })).toHaveCount(0);

    await page.locator('#vagasDateClear').click();
    await openVaga(page, empresaAntiga);
    await deleteOpenVaga(page);
    await openVaga(page, empresaRecente);
    await deleteOpenVaga(page);
  });

  test('filtro Até: exibe apenas vagas com data_envio <= data informada', async ({ page }) => {
    const empresaRecente = `TDateRecente2_${Date.now()}`;
    const empresaFutura  = `TDateFutura_${Date.now()}`;
    const hoje  = new Date().toISOString().slice(0, 10);
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    await createTempVaga(page, empresaRecente, { dataEnvio: hoje });
    await createTempVaga(page, empresaFutura,  { dataEnvio: '2099-12-31' });

    await page.locator('#vagasDateTo').fill(amanha);
    await page.locator('#vagasDateTo').dispatchEvent('change');

    await expect(page.locator('.vagas-table', { hasText: empresaRecente })).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.vagas-table', { hasText: empresaFutura })).toHaveCount(0);

    await page.locator('#vagasDateClear').click();
    await openVaga(page, empresaRecente);
    await deleteOpenVaga(page);
    await openVaga(page, empresaFutura);
    await deleteOpenVaga(page);
  });

  test('botão X limpa filtro de datas e restaura vagas', async ({ page }) => {
    const empresaAntiga  = `TDateClr_${Date.now()}`;
    const empresaRecente = `TDateClrR_${Date.now()}`;
    const hoje = new Date().toISOString().slice(0, 10);

    await createTempVaga(page, empresaAntiga,  { dataEnvio: '2020-01-01' });
    await createTempVaga(page, empresaRecente, { dataEnvio: hoje });

    await page.locator('#vagasDateFrom').fill('2021-01-01');
    await page.locator('#vagasDateFrom').dispatchEvent('change');
    await expect(page.locator('.vagas-table', { hasText: empresaAntiga })).toHaveCount(0);

    await page.locator('#vagasDateClear').click();

    await expect(page.locator('.vagas-table', { hasText: empresaAntiga })).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.vagas-table', { hasText: empresaRecente })).toBeVisible();

    await openVaga(page, empresaAntiga);
    await deleteOpenVaga(page);
    await openVaga(page, empresaRecente);
    await deleteOpenVaga(page);
  });

  // ─── Sub-aba Análise ────────────────────────────────────────

  test('análise: clicar em Análise mostra view de análise e oculta lista', async ({ page }) => {
    await page.locator('.vagas-subtab-btn', { hasText: 'Análise' }).click();
    await expect(page.locator('#vagasAnalysisView')).toBeVisible();
    await expect(page.locator('#vagasListView')).toBeHidden();
  });

  test('análise: clicar em Lista restaura tabela de candidaturas', async ({ page }) => {
    await page.locator('.vagas-subtab-btn', { hasText: 'Análise' }).click();
    await page.locator('.vagas-subtab-btn', { hasText: 'Lista' }).click();
    await expect(page.locator('#vagasListView')).toBeVisible();
    await expect(page.locator('#vagasAnalysisView')).toBeHidden();
  });

  test('análise: KPI Total exibe valor numérico após carregamento', async ({ page }) => {
    await page.locator('.vagas-subtab-btn', { hasText: 'Análise' }).click();
    await expect(page.locator('#vagasAnalysisView')).toBeVisible();
    await expect(page.locator('#vkpi-total')).not.toHaveText('—', { timeout: 10000 });
  });

  test('análise: botões de período atualizam estado ativo', async ({ page }) => {
    await page.locator('.vagas-subtab-btn', { hasText: 'Análise' }).click();
    await page.locator('#vagasAnalysisPeriodBar .metrics-period-btn', { hasText: 'Ano' }).click();
    await expect(page.locator('#vagasAnalysisPeriodBar .metrics-period-btn', { hasText: 'Ano' })).toHaveClass(/active/);
    await expect(page.locator('#vagasAnalysisPeriodBar .metrics-period-btn', { hasText: 'Mês' })).not.toHaveClass(/active/);
  });

  test('análise: modo default é "Dia da semana" e título reflete o modo', async ({ page }) => {
    await page.locator('.vagas-subtab-btn', { hasText: 'Análise' }).click();
    await expect(page.locator('#vagasChartModeBar .metrics-period-btn[data-mode="dow"]')).toHaveClass(/active/);
    await expect(page.locator('#vagasChartTitle')).toHaveText('Candidaturas por dia da semana');
  });

  test('análise: trocar entre os 5 modos atualiza estado ativo e título do gráfico', async ({ page }) => {
    await page.locator('.vagas-subtab-btn', { hasText: 'Análise' }).click();

    const modes = [
      { btn: 'timeline', title: 'Candidaturas ao longo do tempo' },
      { btn: 'wom',      title: 'Candidaturas por semana do mês' },
      { btn: 'dom',      title: 'Candidaturas por dia do mês' },
      { btn: 'moy',      title: 'Candidaturas por mês' },
      { btn: 'dow',      title: 'Candidaturas por dia da semana' },
    ];

    for (const { btn, title } of modes) {
      await page.locator(`#vagasChartModeBar .metrics-period-btn[data-mode="${btn}"]`).click();
      await expect(page.locator(`#vagasChartModeBar .metrics-period-btn[data-mode="${btn}"]`)).toHaveClass(/active/);
      await expect(page.locator('#vagasChartTitle')).toHaveText(title, { timeout: 10000 });
      // Confirma que apenas um botão fica ativo
      await expect(page.locator('#vagasChartModeBar .metrics-period-btn.active')).toHaveCount(1);
    }
  });

  test('análise: período Tudo carrega painéis de distribuição sem "Carregando"', async ({ page }) => {
    const empresa = `Anal_Tudo_${Date.now()}`;
    await createTempVaga(page, empresa);

    await page.locator('.vagas-subtab-btn', { hasText: 'Análise' }).click();
    await page.locator('#vagasAnalysisPeriodBar .metrics-period-btn', { hasText: 'Tudo' }).click();
    await expect(page.locator('#vkpi-total')).not.toHaveText('—', { timeout: 10000 });
    await expect(page.locator('#vagasDistResult')).not.toContainText('Carregando');
    await expect(page.locator('#vagasDistStage')).not.toContainText('Carregando');

    await page.locator('.vagas-subtab-btn', { hasText: 'Lista' }).click();
    await openVaga(page, empresa);
    await deleteOpenVaga(page);
  });

  test('análise: campo De/Até customizado ativa modo custom sem marcar botão de período', async ({ page }) => {
    await page.locator('.vagas-subtab-btn', { hasText: 'Análise' }).click();
    const hoje = new Date().toISOString().slice(0, 10);
    await page.locator('#vagasAnalysisFrom').fill(hoje);
    // Nenhum botão de período padrão deve estar ativo
    const activeBtns = page.locator('#vagasAnalysisPeriodBar .metrics-period-btn.active');
    await expect(activeBtns).toHaveCount(0);
  });
});
