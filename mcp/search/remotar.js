// Scraper do Remotar (remotar.com.br) via Playwright.
// Site usa Vue.js/Nuxt — requer renderização JS.
// URL: https://remotar.com.br/vagas?busca=KEYWORD
// Todas as vagas são remotas (plataforma 100% remota BR).

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { normalize } from './normalizer.js';

chromium.use(StealthPlugin());

const BASE_URL = 'https://remotar.com.br';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Seletores candidatos para cards de vaga (Remotar usa Vue, classe pode variar)
const CARD_SELECTORS = [
    'article[class*="vaga"]',
    '[class*="vaga-card"]',
    '[class*="job-card"]',
    '[class*="card-vaga"]',
    'article[class*="job"]',
    '.job-item',
];

async function extractJobs(page) {
    return page.evaluate((selectors) => {
        for (const sel of selectors) {
            const items = [...document.querySelectorAll(sel)].filter(el =>
                el.querySelector('a') && el.innerText.trim().length > 10
            );
            if (items.length >= 1) {
                return items.slice(0, 40).map(el => {
                    const linkEl = el.querySelector('a[href*="/vagas/"], a[href*="/vaga/"], a[href]');
                    const titleEl = el.querySelector('h1, h2, h3, h4, [class*="title"], [class*="titulo"]');
                    const companyEl = el.querySelector('[class*="empresa"], [class*="company"], [class*="recrutador"]');
                    return {
                        link:    linkEl?.href || null,
                        title:   titleEl?.textContent?.trim() || el.querySelector('strong')?.textContent?.trim() || null,
                        company: companyEl?.textContent?.trim() || null,
                    };
                }).filter(j => j.link && j.title);
            }
        }

        // Último recurso: todos os links que apontam para /vagas/<slug>
        const vagaLinks = [...document.querySelectorAll('a[href*="/vagas/"]')]
            .filter(a => !a.href.endsWith('/vagas') && !a.href.endsWith('/vagas/'));
        if (vagaLinks.length) {
            return vagaLinks.slice(0, 40).map(a => {
                const parent = a.closest('article, li, div[class*="card"], div[class*="vaga"]') || a;
                const titleEl = parent.querySelector('h1, h2, h3, h4') || a;
                return {
                    link:    a.href,
                    title:   titleEl?.textContent?.trim() || a.textContent?.trim() || null,
                    company: parent.querySelector('[class*="empresa"], [class*="company"]')?.textContent?.trim() || null,
                };
            }).filter(j => j.link && j.title);
        }

        return [];
    }, CARD_SELECTORS);
}

export async function searchRemotar({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];
    let browser;

    try {
        browser = await chromium.launch({
            channel: 'chrome',
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });
        const ctx = await browser.newContext({
            viewport:  { width: 1280, height: 800 },
            locale:    'pt-BR',
            userAgent: UA,
        });
        const page = await ctx.newPage();

        for (const keyword of keywords) {
            if (results.length >= maxResults) break;
            console.error(`[remotar] Buscando: "${keyword}"`);

            const url = `${BASE_URL}/vagas?busca=${encodeURIComponent(keyword)}`;
            try {
                await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
            } catch {
                try {
                    await page.goto(url, { waitUntil: 'load', timeout: 25_000 });
                } catch (e) {
                    console.error(`[remotar] Timeout em "${keyword}": ${e.message}`);
                    continue;
                }
            }
            await new Promise(r => setTimeout(r, 2000));

            const jobs = await extractJobs(page);
            console.error(`[remotar] Jobs para "${keyword}": ${jobs.length}`);

            for (const job of jobs) {
                if (results.length >= maxResults) break;
                if (!job.link || seen.has(job.link)) continue;
                seen.add(job.link);
                results.push(normalize({
                    empresa:    job.company || 'Empresa não informada',
                    vaga:       job.title,
                    link_vaga:  job.link,
                    modalidade: 'Remota',
                }, 'remotar'));
            }
            await new Promise(r => setTimeout(r, 800 + Math.random() * 600));
        }

        await page.close();
    } catch (e) {
        console.error(`[remotar] Erro fatal: ${e.message}`);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    console.error(`[remotar] Total coletado: ${results.length}`);
    return results;
}
