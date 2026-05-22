// Smoke tests do demo: verifica que a UI carrega, abas principais funcionam
// e que nenhum erro de console ocorre no fluxo básico.
// Usa injeção de sessionStorage + mocks para não depender de Turnstile.

const { test, expect } = require('@playwright/test');

const DEMO_PATH = '/projeto-sistema-admin.html';
const MOCK_SESSION = 'smoke-0000-0000-0000-000000000001';

const MOCK_LOGS = [
    { id: 'l-1', event_type: 'download', downloaded_at: new Date().toISOString(), token_label: 'Nubank · Ana', cv_version_name: 'QA Sênior', ip_address: '1.2.3.4', country: 'BR', user_agent: 'Playwright' },
];
const MOCK_ANALYTICS = {
    kpis: { pageviews: 42, unique_visitors: 17, engaged_rate: 52, cv_download_clicks: 5, cv_downloads: 3, recurring_visitors: 2 },
    kpis_prev: {},
    series: [], top_pages: [], top_referrers: [], devices: [], countries: [],
    funnel: {}, funnel_unique: {}, hourly: [], dow: [], referrer_conversion: [],
};
const MOCK_TOKENS = [
    { id: 'tk-s1', cv_version_id: 'cv-s1', label: 'Smoke · Test', hash: 'smksmk', use_count: 1, max_uses: 5, expires_at: new Date(Date.now() + 48*3600_000).toISOString(), revoked: false, status: 'ativo', token: 'smksmk', shareUrl: 'https://demo.artacho.dev/cv?t=smksmk', cv_versions: { id: 'cv-s1', name: 'QA Sênior' } },
];
const MOCK_CVS = [
    { id: 'cv-s1', name: 'QA Sênior', description: 'Padrão', file_name: 'cv-smoke.pdf', active: true, created_at: new Date(Date.now() - 86400_000).toISOString() },
];

async function bootSmoke(page) {
    await page.route('**/api/demo/config**', route => route.fulfill({
        json: { turnstile_sitekey: null, enabled_tabs: ['cvs', 'tokens', 'vagas', 'logs', 'metricas'] },
    }));
    await page.route('**/api/demo/cv-versions**', route => route.fulfill({ json: MOCK_CVS }));
    await page.route('**/api/demo/tokens**', route => route.fulfill({ json: MOCK_TOKENS }));
    await page.route('**/api/demo/applications**', route => route.fulfill({ json: [] }));
    await page.route('**/api/demo/logs**', route => route.fulfill({
        json: { data: MOCK_LOGS, total: 1, page: 1, limit: 50, pages: 1 },
    }));
    await page.route('**/api/demo/analytics**', route => route.fulfill({ json: MOCK_ANALYTICS }));
    await page.route('**/api/demo/storage-stats**', route => route.fulfill({ json: {
        bucket: 'demo-cvs', files_count: 1, used_bytes: 320_000,
        limit_bytes: 1_073_741_824, used_percent: 0.03,
        alert_threshold_percent: 80, should_alert: false, dashboard_url: null,
    }}));

    await page.goto(DEMO_PATH, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.evaluate((sid) => {
        sessionStorage.setItem('demo_authed', '1');
        sessionStorage.setItem('demo_session_id', sid);
        sessionStorage.setItem('demo_tour_done', '1');
    }, MOCK_SESSION);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('appScreen')?.style.display === 'block', { timeout: 10_000 });
}

test.describe('DEMO — smoke (abas e zero erros de console)', () => {
    test('login, Logs, Métricas e token link', async ({ page }) => {
        const errors = [];
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', e => errors.push(String(e)));

        await bootSmoke(page);

        // App revelado: abas presentes
        await expect(page.locator('.tab-btn[data-tab="logs"]')).toBeVisible();
        await expect(page.locator('.tab-btn[data-tab="metricas"]')).toBeVisible();

        // Aba Logs
        await page.locator('.tab-btn[data-tab="logs"]').click();
        await expect(page.locator('#logTable tr').first()).toBeVisible();
        await expect(page.locator('#kpiLogTotal')).not.toHaveText('—', { timeout: 8000 });

        // Aba Métricas
        await page.locator('.tab-btn[data-tab="metricas"]').click();
        await expect(page.locator('#kpi-pageviews')).not.toHaveText('—', { timeout: 8000 });
        await expect(page.locator('#analyticsChart')).toBeVisible();

        // Tokens: shareUrl do token é um link sandbox demo.artacho.dev
        await page.locator('.tab-btn[data-tab="tokens"]').click();
        await expect(page.locator('#tokenTable tr').first()).toBeVisible({ timeout: 8000 });

        expect(errors, 'erros de console: ' + errors.join(' | ')).toEqual([]);
    });
});
