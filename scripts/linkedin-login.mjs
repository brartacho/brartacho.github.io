/**
 * Login interativo no LinkedIn para o scraper de vagas.
 * Uso: node scripts/linkedin-login.mjs
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, '..', 'mcp', '.linkedin-session.json');

const LOGGED_IN_PATTERNS = [
    '/feed',
    '/jobs',
    '/mynetwork',
    '/messaging',
    '/notifications',
];

function isLoggedIn(url) {
    return LOGGED_IN_PATTERNS.some(p => url.includes(p));
}

console.log('');
console.log('══════════════════════════════════════════════');
console.log('  Login LinkedIn — Radar de Vagas');
console.log('══════════════════════════════════════════════');
console.log('');
console.log('1. O Chrome vai abrir agora');
console.log('2. Faça login normalmente (email + senha + 2FA)');
console.log('3. Ao chegar no feed, este script detecta e fecha');
console.log('   Você tem 5 minutos.');
console.log('');

let browser;
try {
    // Usa Chrome real instalado (channel:'chrome') — mais compatível com LinkedIn
    browser = await chromium.launch({
        channel: 'chrome',
        headless: false,
        args: ['--no-sandbox', '--disable-infobars'],
    });
} catch {
    // Fallback: Chromium bundled do Playwright
    console.log('(Chrome não encontrado, usando Chromium bundled)');
    browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox'],
    });
}

const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'pt-BR',
});

const page = await context.newPage();

try {
    await page.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
    });
} catch (e) {
    console.error('Aviso ao carregar página de login:', e.message);
    // Continua mesmo assim — pode ter redirecionado para outra URL de login
}

console.log('⏳ Aguardando login... URL atual:', page.url());
console.log('   Faça login no browser que abriu. Este terminal aguarda.');
console.log('');

// Polling: verifica URL a cada 2s por até 5 minutos
const TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS    = 2_000;
const start      = Date.now();
let   loggedIn   = false;

while (Date.now() - start < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_MS));

    let currentUrl;
    try {
        currentUrl = page.url();
    } catch {
        break; // browser fechado pelo usuário
    }

    if (isLoggedIn(currentUrl)) {
        loggedIn = true;
        break;
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r   Aguardando... ${elapsed}s | URL: ${currentUrl.slice(0, 60)}`);
}

console.log('');

if (!loggedIn) {
    console.error('');
    console.error('❌ Login não detectado em 5 minutos.');
    console.error('   Verifique se chegou ao feed do LinkedIn e tente novamente.');
    await browser.close();
    process.exit(1);
}

console.log('✅ Login detectado! Salvando cookies...');
const cookies = await context.cookies();
writeFileSync(
    SESSION_FILE,
    JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2),
    'utf8'
);

await browser.close();

console.log('');
console.log('✅ Sessão salva com sucesso!');
console.log(`   Arquivo: mcp/.linkedin-session.json`);
console.log('   Válida por: 25 dias');
console.log('');
console.log('Agora use no Claude Code:');
console.log('  search_linkedin(dry_run=true)  → testa sem salvar');
console.log('  search_all()                    → busca em todas as plataformas');
console.log('');
