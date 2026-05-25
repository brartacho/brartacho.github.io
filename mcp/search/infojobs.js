// Scraper do InfoJobs Brasil via Playwright + stealth.
// URL: https://www.infojobs.com.br/empregos.aspx?palabra={keyword}
// Cloudflare presente — usa playwright-extra + stealth plugin.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { normalize } from './normalizer.js';

chromium.use(StealthPlugin());

const BASE_URL = 'https://www.infojobs.com.br';

export async function searchInfojobs({ keywords, maxResults = 20 }) {
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
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        });

        const page = await ctx.newPage();

        for (const keyword of keywords) {
            if (results.length >= maxResults) break;

            console.error(`[infojobs] Buscando: "${keyword}"`);
            const url = `${BASE_URL}/empregos.aspx?palabra=${encodeURIComponent(keyword)}`;

            try {
                await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
            } catch {
                try {
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
                    await new Promise(r => setTimeout(r, 3000));
                } catch {
                    console.error(`[infojobs] Timeout para "${keyword}"`);
                    continue;
                }
            }

            const title = await page.title();
            console.error(`[infojobs] Título: "${title}" | URL: ${page.url()}`);

            if (/blocked|access denied|just a moment|cloudflare/i.test(title)) {
                console.error(`[infojobs] Bloqueado para "${keyword}"`);
                continue;
            }

            const jobs = await page.evaluate(() => {
                // Cards: div[data-id] com classe js_cardLink
                const cards = [...document.querySelectorAll('div[data-id].js_cardLink')];

                console.log(`[infojobs-eval] ${cards.length} cards encontrados`);

                return cards.map(card => {
                    const titleEl = card.querySelector('.js_vacancyTitle');
                    // Empresa: tenta múltiplos seletores
                    const compEl = card.querySelector([
                        'a[href*="empresa"]',
                        '.js_vacancy-company',
                        '[class*="company"]',
                        '[class*="empresa"]',
                        'span[class*="companyName"]',
                        'p[class*="company"]',
                    ].join(','));
                    const locEl = card.querySelector([
                        '.js_vacancyDataPanels [class*="location"]',
                        '[class*="locality"]',
                        'span[class*="location"]',
                        '[class*="cidade"]',
                        '[data-testid*="location"]',
                    ].join(','));
                    // Modalidade pode aparecer como badge no card
                    const modEl = card.querySelector('[class*="workday"], [class*="remote"], [class*="modalidade"]');
                    const dataHref = card.getAttribute('data-href');
                    const link = dataHref
                        ? (dataHref.startsWith('http') ? dataHref : `https://www.infojobs.com.br${dataHref}`)
                        : null;
                    return {
                        vaga:        titleEl?.textContent?.trim() || '',
                        empresa:     (compEl?.textContent || '').replace(/\s+/g, ' ').trim(),
                        localizacao: locEl?.textContent?.trim() || '',
                        modalidade:  modEl?.textContent?.trim() || '',
                        link,
                    };
                }).filter(j => j.vaga && j.link);
            });

            console.error(`[infojobs] Cards para "${keyword}": ${jobs.length}`);

            for (const job of jobs) {
                if (results.length >= maxResults) break;
                if (!job.link || seen.has(job.link)) continue;
                seen.add(job.link);

                // Busca descrição na página de detalhe
                let descricao = null;
                try {
                    await page.goto(job.link, { waitUntil: 'domcontentloaded', timeout: 20_000 });
                    await new Promise(r => setTimeout(r, 1500));
                    descricao = await page.evaluate(() => {
                        const sels = [
                            '#oferta-description',
                            '.oferta-description',
                            '[class*="description"]',
                            '[id*="description"]',
                            '.detalle-oferta',
                            'section[class*="detail"]',
                        ];
                        for (const sel of sels) {
                            const t = document.querySelector(sel)?.innerText?.trim();
                            if (t && t.length > 50) return t;
                        }
                        return null;
                    });
                } catch { /* descrição opcional */ }

                results.push(normalize({
                    empresa:    job.empresa || 'Empresa não informada',
                    vaga:       job.vaga,
                    link_vaga:  job.link,
                    localizacao: job.localizacao || null,
                    modalidade:  job.modalidade  || null,
                    descricao,
                }, 'infojobs'));

                await new Promise(r => setTimeout(r, 800 + Math.random() * 1000));
            }

            await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
        }
    } catch (e) {
        console.error(`[infojobs] Erro fatal: ${e.message}`);
    } finally {
        await browser?.close().catch(() => {});
    }

    console.error(`[infojobs] Total coletado: ${results.length}`);
    return results;
}
