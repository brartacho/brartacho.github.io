// Scraper do Remotar (remotar.com.br) via Playwright.
// Site Next.js — requer renderização JS.
// URL de busca: https://remotar.com.br/search/jobs?q=KEYWORD
// Todas as vagas são remotas (plataforma 100% remota BR).
//
// Padrão de links: https://remotar.com.br/job/<id>/<empresa>/<slug>
// Cards têm classes: job-content-box, job-title, job-detail.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { normalize } from './normalizer.js';

chromium.use(StealthPlugin());

const BASE_URL = 'https://remotar.com.br';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function extractJobs(page) {
    return page.evaluate(() => {
        const anchors = [...document.querySelectorAll('a[href*="/job/"]')]
            .filter(a => /\/job\/\d+\//.test(a.href));

        const seen = new Set();
        const out  = [];
        for (const a of anchors) {
            if (seen.has(a.href)) continue;
            seen.add(a.href);

            const card    = a.closest('article, li, [class*="job-content"], [class*="job-card"], div[class]') || a;
            const titleEl = card.querySelector('.job-title, h2, h3, h4');
            const title   = (titleEl?.textContent || a.textContent || '').trim();
            if (!title) continue;

            // Tenta extrair empresa do slug: /job/<id>/<empresa>/<slug>
            const match   = a.href.match(/\/job\/\d+\/([^/]+)\//);
            const slugCo  = match ? match[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null;
            const compEl  = card.querySelector('[class*="empresa"], [class*="company"], .job-detail');
            const company = compEl?.textContent?.trim().split('\n')[0] || slugCo || null;

            out.push({ link: a.href, title, company });
        }
        return out;
    });
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

            const url = `${BASE_URL}/search/jobs?q=${encodeURIComponent(keyword)}`;
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            } catch (e) {
                console.error(`[remotar] Timeout em "${keyword}": ${e.message}`);
                continue;
            }
            try {
                await page.waitForSelector('a[href*="/job/"]', { timeout: 8_000 });
            } catch {
                // Sem resultados ou layout diferente — segue mesmo assim
            }
            await new Promise(r => setTimeout(r, 1500));

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
