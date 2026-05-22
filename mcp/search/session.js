// Gerenciador de sessão LinkedIn para o scraper local.
// Salva/carrega cookies em .linkedin-session.json (gitignored).
// Na primeira execução (sem cookies válidos) abre browser VISÍVEL para login manual.
// Nas execuções seguintes usa headless com cookies injetados.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, '..', '.linkedin-session.json');
const SESSION_TTL_MS = 25 * 24 * 60 * 60 * 1000; // 25 dias

function loadSession() {
    if (!existsSync(SESSION_FILE)) return null;
    try {
        const raw = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
        if (!raw?.cookies?.length || !raw?.savedAt) return null;
        const age = Date.now() - new Date(raw.savedAt).getTime();
        if (age > SESSION_TTL_MS) {
            console.error('[session] Cookies expirados (>25 dias). Será necessário novo login.');
            return null;
        }
        return raw.cookies;
    } catch {
        return null;
    }
}

function saveSession(cookies) {
    writeFileSync(SESSION_FILE, JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2), 'utf8');
    console.error('[session] Cookies salvos em .linkedin-session.json');
}

export function clearSession() {
    if (existsSync(SESSION_FILE)) {
        unlinkSync(SESSION_FILE);
        return true;
    }
    return false;
}

async function loginInteractive(playwright) {
    console.error('[session] Abrindo browser para login no LinkedIn...');
    console.error('[session] Por favor, faça login. O browser fechará automaticamente ao detectar a sessão.');

    const browser = await playwright.chromium.launch({
        headless: false,
        args: ['--start-maximized'],
    });
    const context = await browser.newContext({
        viewport: null,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });

    // Aguarda o usuário concluir o login (URL muda para /feed ou /jobs)
    console.error('[session] Aguardando login... (timeout: 3 minutos)');
    await page.waitForURL(
        (url) => url.includes('linkedin.com/feed') || url.includes('linkedin.com/jobs') || url.includes('linkedin.com/in/'),
        { timeout: 180_000 }
    );

    const cookies = await context.cookies();
    saveSession(cookies);

    await browser.close();
    console.error('[session] Login concluído. Cookies salvos.');
    return cookies;
}

export async function ensureSession(playwright) {
    let cookies = loadSession();

    if (!cookies) {
        cookies = await loginInteractive(playwright);
    }

    const browser = await playwright.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        locale: 'pt-BR',
        extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' },
    });

    await context.addCookies(cookies);
    return { browser, context };
}

export async function refreshSession(context) {
    const cookies = await context.cookies('https://www.linkedin.com');
    if (cookies.length > 0) saveSession(cookies);
}
