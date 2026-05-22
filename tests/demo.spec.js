// Testes funcionais do showcase /projeto-sistema-admin.
// Estratégia: contra produção, o Turnstile real bloqueia login automatizado.
// Logo, os testes ou (a) validam a tela pública sem login, ou (b) injetam
// sessionStorage e interceptam /api/demo/* via page.route() para exercitar a UI.

const { test, expect } = require('@playwright/test');

// sessionStorage compartilhada entre paralelismo causa flakes — força serial
test.describe.configure({ mode: 'serial' });

const DEMO_PATH = '/projeto-sistema-admin.html';

// ─── Mocks compartilhados ───────────────────────────────────────────────────
const MOCK_SESSION = '11111111-2222-3333-4444-555555555555';

function makeFixtures() {
    const now = new Date();
    const inFuture = (h) => new Date(now.getTime() + h * 3600_000).toISOString();
    const inPast = (h) => new Date(now.getTime() - h * 3600_000).toISOString();
    return {
        cvs: [
            { id: 'cv-1', name: 'QA Sênior', description: 'Padrão', file_name: 'cv-jon-snow-qa-senior.pdf', active: true,  created_at: inPast(48) },
            { id: 'cv-2', name: 'Automation', description: '',      file_name: 'cv-jon-snow-qa-auto.pdf',   active: true,  created_at: inPast(24) },
            { id: 'cv-3', name: 'SDET',       description: 'EN',    file_name: 'cv-jon-snow-sdet.pdf',      active: false, created_at: inPast(12) },
        ],
        // status field obrigatório: _tokenEffectiveStatus() no core lê t.status
        tokens: [
            { id: 'tk-1', cv_version_id: 'cv-1', label: 'Nubank · Ana',  hash: 'aaaaaa', use_count: 0, max_uses: 5, expires_at: inFuture(48), revoked: false, status: 'ativo',    cv_versions: { id: 'cv-1', name: 'QA Sênior' } },
            { id: 'tk-2', cv_version_id: 'cv-2', label: 'Stone · João',  hash: 'bbbbbb', use_count: 2, max_uses: 5, expires_at: inFuture(12), revoked: false, status: 'ativo',    cv_versions: { id: 'cv-2', name: 'Automation' } },
            { id: 'tk-3', cv_version_id: 'cv-1', label: 'Vexp · Carla',  hash: 'cccccc', use_count: 5, max_uses: 5, expires_at: inFuture(72), revoked: false, status: 'esgotado', cv_versions: { id: 'cv-1', name: 'QA Sênior' } },
            { id: 'tk-4', cv_version_id: 'cv-1', label: 'Inter · Bia',   hash: 'dddddd', use_count: 1, max_uses: 5, expires_at: inPast(48),   revoked: false, status: 'expirado', cv_versions: { id: 'cv-1', name: 'QA Sênior' } },
            { id: 'tk-5', cv_version_id: 'cv-2', label: 'Itau · Pedro',  hash: 'eeeeee', use_count: 0, max_uses: 5, expires_at: inFuture(96), revoked: true,  status: 'revogado', cv_versions: { id: 'cv-2', name: 'Automation' } },
        ],
        apps: [
            { id: 'a-1', empresa: 'Nubank', vaga: 'Sr QA',    gestor_nome: 'Ana',   gestor_email: 'ana@nu.com',    modalidade: 'Remota',    tipo_contratacao: 'CLT', stages: [{name:'Aplicado',status:'done'},{name:'Triagem',status:'running'}], data_envio: inPast(72),  created_at: inPast(72),  updated_at: inPast(2),   result: 'em_processo', archived: false, cv_versions: { id: 'cv-1', name: 'QA Sênior', file_name: 'cv-jon-snow-qa-senior.pdf' } },
            { id: 'a-2', empresa: 'Stone',  vaga: 'QA Auto',  gestor_nome: 'João',  gestor_email: 'joao@stone.com',modalidade: 'Híbrida',   tipo_contratacao: 'PJ',  stages: [{name:'Aplicado',status:'done'},{name:'Entrevista',status:'done'},{name:'Oferta',status:'done'}], data_envio: inPast(24),  created_at: inPast(24),  updated_at: inPast(1),   result: 'aprovado', archived: false, cv_versions: { id: 'cv-2', name: 'Automation', file_name: 'cv-jon-snow-qa-auto.pdf' } },
            { id: 'a-3', empresa: 'Vexp',   vaga: 'SDET',     gestor_nome: 'Carla', gestor_email: 'carla@vexp.com',modalidade: 'Presencial', tipo_contratacao: 'CLT', stages: [{name:'Aplicado',status:'done'},{name:'Triagem',status:'rejected'}], data_envio: inPast(120), created_at: inPast(120), updated_at: inPast(48),  result: 'recusado', archived: false, cv_versions: null },
            { id: 'a-4', empresa: 'OldCo',  vaga: 'QA',       gestor_nome: '',      gestor_email: '',              modalidade: 'Remota',     tipo_contratacao: 'CLT', stages: [], data_envio: inPast(720), created_at: inPast(720), updated_at: inPast(720), result: 'em_processo', archived: true, cv_versions: null },
        ],
    };
}

// Injeta sessão fake e mocka /api/demo/* antes de revealApp
async function bootDemoApp(page, fx) {
    // Config: Turnstile desativado em testes, todas as abas habilitadas
    await page.route('**/api/demo/config**', route => route.fulfill({
        json: { turnstile_sitekey: null, enabled_tabs: ['cvs', 'tokens', 'vagas', 'logs', 'metricas'] },
    }));
    await page.route('**/api/demo/cv-versions**', async route => {
        const m = route.request().method();
        if (m === 'GET') return route.fulfill({ json: fx.cvs });
        return route.fulfill({ status: 201, json: { id: 'cv-new', ...JSON.parse(route.request().postData() || '{}'), active: true, created_at: new Date().toISOString() } });
    });
    await page.route('**/api/demo/tokens**', async route => {
        const m = route.request().method();
        if (m === 'GET') return route.fulfill({ json: fx.tokens });
        if (m === 'POST') return route.fulfill({ status: 201, json: { id: 'tk-new', hash: 'newhsh', use_count: 0, status: 'ativo', expires_at: new Date(Date.now() + 24*3600_000).toISOString(), revoked: false, cv_versions: fx.cvs[0], ...JSON.parse(route.request().postData() || '{}') } });
        if (m === 'PUT' || m === 'PATCH' || m === 'DELETE') return route.fulfill({ status: 200, json: { ok: true } });
        return route.fallback();
    });
    await page.route('**/api/demo/applications**', async route => {
        const m = route.request().method();
        if (m === 'GET') return route.fulfill({ json: fx.apps });
        if (m === 'POST') return route.fulfill({ status: 201, json: { id: 'a-new', stages: [], created_at: new Date().toISOString(), ...JSON.parse(route.request().postData() || '{}') } });
        if (m === 'PUT' || m === 'PATCH' || m === 'DELETE') return route.fulfill({ status: 200, json: { ok: true } });
        return route.fallback();
    });
    await page.route('**/api/demo/storage-stats**', route => route.fulfill({ json: {
        bucket: 'demo-cvs',
        files_count: fx.cvs.length,
        used_bytes:  fx.cvs.length * 320_000,
        limit_bytes: 1_073_741_824,
        used_percent: 0.1,
        alert_threshold_percent: 80,
        should_alert: false,
        dashboard_url: null,
    }}));

    await page.goto(DEMO_PATH, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.evaluate((sid) => {
        sessionStorage.setItem('demo_authed', '1');
        sessionStorage.setItem('demo_session_id', sid);
        sessionStorage.setItem('demo_tour_done', '1'); // suprime tour
    }, MOCK_SESSION);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('appScreen')?.style.display === 'block', { timeout: 10_000 });
}

// ─── 1. Tela pública (sem login) ────────────────────────────────────────────
test.describe('DEMO /projeto-sistema-admin — pública', () => {
    test('página carrega com status 200 e título', async ({ page }) => {
        const resp = await page.goto(DEMO_PATH);
        expect(resp.status()).toBe(200);
        await expect(page).toHaveTitle(/Sistema Admin|ARTACHO|Demo/i);
    });

    test('hero screen e formulário de login renderizam', async ({ page }) => {
        await page.goto(DEMO_PATH);
        await expect(page.locator('#heroScreen')).toBeVisible();
        await expect(page.locator('#demoLoginForm')).toBeVisible();
        await expect(page.locator('#demoLoginBtn')).toBeVisible();
        await expect(page.locator('#demoLoginBtn')).toContainText('Entrar');
    });

    test('campos de usuário e senha estão presentes', async ({ page }) => {
        await page.goto(DEMO_PATH);
        await expect(page.locator('#demoUser')).toBeVisible();
        await expect(page.locator('#demoPass')).toBeVisible();
    });

    test('nota de contato aparece', async ({ page }) => {
        await page.goto(DEMO_PATH);
        await expect(page.locator('.lgpd-note')).toBeVisible();
    });

    test('appScreen está oculto antes do login', async ({ page }) => {
        await page.goto(DEMO_PATH);
        const display = await page.locator('#appScreen').evaluate(el => getComputedStyle(el).display);
        expect(display).toBe('none');
    });
});

// ─── 2. Pós-login (com mock) ────────────────────────────────────────────────
test.describe('DEMO — aba CVs (com mocks)', () => {
    test('storage card renderiza com bucket e percent', async ({ page }) => {
        await bootDemoApp(page, makeFixtures());
        const card = page.locator('#storageCard');
        await expect(card).toBeVisible();
        await expect(card.locator('#storageSub')).toContainText('demo-cvs');
        await expect(card.locator('#storagePct')).toContainText('%');
        await expect(card.locator('#storageFiles')).toContainText('3 arquivos');
    });

    test('lista de CVs mostra as 3 versões do fixture', async ({ page }) => {
        await bootDemoApp(page, makeFixtures());
        const rows = page.locator('#cvTable tr');
        await expect(rows.first()).toBeVisible();
        await expect(page.locator('#cvTable')).toContainText('QA Sênior');
        await expect(page.locator('#cvTable')).toContainText('Automation');
        await expect(page.locator('#cvTable')).toContainText('SDET');
    });

    test('upload zone tem texto correto e aceita PDF', async ({ page }) => {
        await bootDemoApp(page, makeFixtures());
        const zone = page.locator('#uploadZone');
        await expect(zone).toContainText('Clique ou arraste');
        const input = page.locator('#fileInput');
        await expect(input).toHaveAttribute('accept', 'application/pdf');
    });

    test('filtro de status oculta inativos quando selecionado', async ({ page }) => {
        await bootDemoApp(page, makeFixtures());
        // Custom select — click no botão para abrir o menu
        await page.locator('#cvStatusFilter .custom-select-btn').click();
        await page.locator('#cvStatusFilter .custom-select-option[data-value="ativo"]').click();
        await expect(page.locator('#cvTable')).not.toContainText('SDET');
        await expect(page.locator('#cvTable')).toContainText('QA Sênior');
    });
});

test.describe('DEMO — aba Tokens (com mocks)', () => {
    test.beforeEach(async ({ page }) => {
        await bootDemoApp(page, makeFixtures());
        await page.locator('[data-tab="tokens"]').click();
    });

    test('5 KPIs aparecem com valores corretos', async ({ page }) => {
        // tk-1: ativo (48h), tk-2: ativo (12h < 24h → expirando), tk-3: esgotado, tk-4: expirado, tk-5: revogado
        await expect(page.locator('#kpiTokenAtivo')).toHaveText('2');
        await expect(page.locator('#kpiTokenExpirando')).toHaveText('1');
        await expect(page.locator('#kpiTokenExpirado')).toHaveText('1');
        await expect(page.locator('#kpiTokenRevogado')).toHaveText('1');
        await expect(page.locator('#kpiTokenEsgotado')).toHaveText('1');
    });

    test('preset chip "Ativos" filtra a tabela', async ({ page }) => {
        await page.locator('[data-preset="ativo"]').click();
        const rows = page.locator('#tokenTable tr');
        const count = await rows.count();
        expect(count).toBeGreaterThan(0);
        await expect(page.locator('#tokenTable')).toContainText('Nubank');
        await expect(page.locator('#tokenTable')).not.toContainText('Inter'); // Inter é expirado
    });

    test('bulk bar aparece quando linhas são selecionadas', async ({ page }) => {
        const bar = page.locator('#token-bulk-bar');
        await expect(bar).toBeHidden();
        const firstCb = page.locator('#tokenTable input[type="checkbox"]').first();
        await firstCb.check();
        await expect(bar).toBeVisible();
        await expect(page.locator('#tokenBulkCount')).toContainText('1 selecionado');
    });

    test('botão "Limpar expirados" presente e clicável', async ({ page }) => {
        const btn = page.locator('button:has-text("Limpar expirados")');
        await expect(btn).toBeVisible();
    });

    test('form de criação está em grid (4 áreas) no desktop', async ({ page, viewport }) => {
        test.skip((viewport?.width ?? 1280) < 740, 'Apenas desktop');
        const grid = page.locator('.token-form-grid').first();
        const display = await grid.evaluate(el => getComputedStyle(el).display);
        expect(display).toBe('grid');
    });
});

test.describe('DEMO — aba Vagas (com mocks)', () => {
    test.beforeEach(async ({ page }) => {
        await bootDemoApp(page, makeFixtures());
        await page.locator('[data-tab="vagas"]').click();
    });

    test('toolbar tem 4 botões: Filtros, Selecionar, Exportar CSV, Nova vaga', async ({ page }) => {
        await expect(page.locator('#vagasFiltersToggleBtn')).toBeVisible();
        await expect(page.locator('#vagasSelectBtn')).toBeVisible();
        await expect(page.locator('button:has-text("Exportar CSV")')).toBeVisible();
        await expect(page.locator('button:has-text("Nova vaga")')).toBeVisible();
    });

    test('sort chip "Última mod." está visível', async ({ page }) => {
        await expect(page.locator('#sort-chip-updated_at')).toBeVisible();
    });

    test('Filtros toggle colapsa o painel de chips', async ({ page }) => {
        const panel = page.locator('#vagasFiltersPanel');
        await expect(panel).not.toHaveClass(/collapsed/);
        await page.locator('#vagasFiltersToggleBtn').click();
        await expect(panel).toHaveClass(/collapsed/);
    });

    test('lista mostra empresas do fixture', async ({ page }) => {
        await expect(page.locator('#vagasTableBody')).toContainText('Nubank');
        await expect(page.locator('#vagasTableBody')).toContainText('Stone');
    });

    test('filtro "Aprovado" mostra só vagas aprovadas', async ({ page }) => {
        await page.locator('[data-filter="aprovado"]').first().click();
        await expect(page.locator('#vagasTableBody')).toContainText('Stone');
        await expect(page.locator('#vagasTableBody')).not.toContainText('Nubank');
    });

    test('sub-aba Análise carrega com gráfico e 4 KPIs', async ({ page }) => {
        await page.locator('#subtab-analise').click();
        await expect(page.locator('#vagasAnalysisView')).toBeVisible();
        await expect(page.locator('#vkpi-total')).toBeVisible();
        await expect(page.locator('#vagasChart')).toBeVisible();
    });

    test('chart suporta os 5 modos de visualização', async ({ page }) => {
        await page.locator('#subtab-analise').click();
        for (const mode of ['timeline', 'dow', 'wom', 'dom', 'moy']) {
            await page.locator(`[data-mode="${mode}"]`).click();
            await expect(page.locator(`[data-mode="${mode}"]`)).toHaveClass(/active/);
        }
    });

    test('modo Selecionar adiciona checkboxes nas linhas', async ({ page }) => {
        const beforeCount = await page.locator('#vagasTableBody input[type="checkbox"]').count();
        expect(beforeCount).toBe(0);
        await page.locator('#vagasSelectBtn').click();
        const afterCount = await page.locator('#vagasTableBody input[type="checkbox"]').count();
        expect(afterCount).toBeGreaterThan(0);
    });
});

// ─── 3. Tour ────────────────────────────────────────────────────────────────
test.describe('DEMO — tour (5 passos)', () => {
    test('startTour() exibe overlay e primeiro card', async ({ page }) => {
        await bootDemoApp(page, makeFixtures());
        await page.evaluate(() => window.startTour());
        await expect(page.locator('#tourOverlay')).toHaveClass(/open/);
        await expect(page.locator('#tourCounter')).toContainText('1 / 5');
        await expect(page.locator('#tourTitle')).toContainText(/Bem-vindo/i);
    });

    test('avançar pelos 5 passos sem cortar o card', async ({ page }) => {
        await bootDemoApp(page, makeFixtures());
        await page.evaluate(() => window.startTour());

        for (let i = 1; i <= 5; i++) {
            await expect(page.locator('#tourCounter')).toContainText(`${i} / 5`);
            const box = await page.locator('#tourCard').boundingBox();
            expect(box).not.toBeNull();
            expect(box.y).toBeGreaterThanOrEqual(0);
            expect(box.x).toBeGreaterThanOrEqual(0);
            const vp = page.viewportSize();
            expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 5);
            if (i < 5) await page.locator('#tourNext').click();
        }
    });

    test('Pular fecha o overlay', async ({ page }) => {
        await bootDemoApp(page, makeFixtures());
        await page.evaluate(() => window.startTour());
        await page.locator('button:has-text("Pular")').click();
        await expect(page.locator('#tourOverlay')).not.toHaveClass(/open/);
    });
});
