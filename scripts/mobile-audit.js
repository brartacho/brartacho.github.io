// Script de auditoria mobile — captura screenshots de todas as telas do admin
// Roda: node scripts/mobile-audit.js
import { chromium, devices } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.BASE_URL || 'https://artacho.dev';
const EMAIL    = process.env.ADMIN_EMAIL    || 'bruno@artacho.dev';
const PASS     = process.env.ADMIN_PASSWORD || '';

const OUT_IPHONE  = path.join(__dirname, '..', 'test-results', 'mobile-audit');
const OUT_ANDROID = path.join(__dirname, '..', 'test-results', 'mobile-audit-android');

fs.mkdirSync(OUT_IPHONE,  { recursive: true });
fs.mkdirSync(OUT_ANDROID, { recursive: true });

async function shot(page, outDir, name) {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
    console.log(`  📸 ${name}.png`);
}

async function auditFlow(page, outDir) {
    console.log('→ Login...');
    await page.goto(`${BASE_URL}/admin`, { waitUntil: 'networkidle' });
    await shot(page, outDir, '00-login');

    await page.fill('#loginUsername', EMAIL);
    await page.fill('#loginPassword', PASS);
    await page.click('#loginBtn');
    await page.waitForSelector('.app-tabs', { timeout: 15000 });
    await page.waitForTimeout(1200);

    async function clickTab(label) {
        await page.locator('.tab-btn', { hasText: label }).click();
        await page.waitForTimeout(900);
    }

    console.log('→ Tabs principais...');
    await shot(page, outDir, '01-dashboard-cvs');

    await clickTab('Tokens');
    await shot(page, outDir, '02-tab-tokens');

    await clickTab('Vagas');
    await shot(page, outDir, '03-tab-vagas');

    await clickTab('Logs');
    await shot(page, outDir, '04-tab-logs');

    await page.evaluate(() => window.scrollTo(0, 200));
    await page.waitForTimeout(300);
    await shot(page, outDir, '05-logs-scroll');

    console.log('→ Modal de criar token...');
    await clickTab('Tokens');
    const novoTokenBtn = page.locator('button', { hasText: /novo token/i }).first();
    if (await novoTokenBtn.isVisible().catch(() => false)) {
        await novoTokenBtn.click();
        await page.waitForTimeout(600);
        await shot(page, outDir, '06-modal-novo-token');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
    }

    console.log('→ Drawer de vaga...');
    await clickTab('Vagas');
    const primeiraVaga = page.locator('.vagas-table tbody tr').first();
    if (await primeiraVaga.isVisible().catch(() => false)) {
        await primeiraVaga.click();
        await page.waitForTimeout(700);
        await shot(page, outDir, '07-drawer-vaga-topo');
        await page.evaluate(() => {
            const d = document.querySelector('.vagas-drawer');
            if (d) d.scrollTop = 350;
        });
        await page.waitForTimeout(300);
        await shot(page, outDir, '08-drawer-vaga-scroll');
        await page.locator('#vagasOverlay').click({ force: true }).catch(() => page.keyboard.press('Escape'));
        await page.waitForTimeout(300);
    }

    console.log('→ Modal compartilhar token...');
    await clickTab('Tokens');
    const shareBtn = page.locator('.tbl-wrap tbody td:not([data-label]) button').first();
    if (await shareBtn.isVisible().catch(() => false)) {
        await shareBtn.click();
        await page.waitForTimeout(600);
        const shareModal = page.locator('#shareModal.open');
        if (await shareModal.isVisible().catch(() => false)) {
            await shot(page, outDir, '09-modal-share');
            const emailBtn = page.locator('#emailBtn');
            if (await emailBtn.isVisible().catch(() => false)) {
                await emailBtn.click();
                await page.waitForTimeout(400);
                await shot(page, outDir, '10-modal-share-email-form');
            }
            await page.keyboard.press('Escape');
        }
    }

    console.log('→ CVs — accordion upload...');
    await clickTab('Currículos');
    await shot(page, outDir, '11-cvs-lista');
    const uploadToggle = page.locator('#cvsUploadToggleBtn');
    if (await uploadToggle.isVisible().catch(() => false)) {
        await uploadToggle.click();
        await page.waitForTimeout(400);
        await shot(page, outDir, '12-cvs-upload-aberto');
    } else {
        await page.evaluate(() => window.scrollTo(0, 400));
        await page.waitForTimeout(300);
        await shot(page, outDir, '12-cvs-scroll');
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });

    console.log('\n═══ iPhone 14 ════════════════════════════════');
    const ctxiPhone = await browser.newContext({ ...devices['iPhone 14'], locale: 'pt-BR' });
    const pageIPhone = await ctxiPhone.newPage();
    await auditFlow(pageIPhone, OUT_IPHONE);
    await ctxiPhone.close();
    console.log(`✅ iPhone screenshots: ${OUT_IPHONE}`);

    console.log('\n═══ Pixel 7 (Android) ════════════════════════');
    const ctxPixel = await browser.newContext({ ...devices['Pixel 7'], locale: 'pt-BR' });
    const pagePixel = await ctxPixel.newPage();
    await auditFlow(pagePixel, OUT_ANDROID);
    await ctxPixel.close();
    console.log(`✅ Android screenshots: ${OUT_ANDROID}`);

    await browser.close();
    console.log('\n✅ Auditoria concluída.');
})().catch(e => { console.error(e); process.exit(1); });
