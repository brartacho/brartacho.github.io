// Scraper do InfoJobs Brasil via Playwright + stealth.
// URL: https://www.infojobs.com.br/vagas-de-emprego,{slug}.aspx
// Cloudflare presente — usa playwright-extra + stealth plugin.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { normalize } from './normalizer.js';

chromium.use(StealthPlugin());

const BASE_URL = 'https://www.infojobs.com.br';

function toSlug(kw) {
    return kw.toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

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
            const slug = toSlug(keyword);
            const url  = `${BASE_URL}/vagas-de-emprego,${slug}.aspx`;

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
                const CARD_SELECTORS = [
                    '.ij-offersitem',
                    '.offer-item',
                    '[class*="offerItem"]',
                    '[class*="offer-item"]',
                    'li[class*="offer"]',
                    'article[class*="offer"]',
                    '.jobs-list-item',
                ];

                let cards = [];
                for (const sel of CARD_SELECTORS) {
                    cards = [...document.querySelectorAll(sel)];
                    if (cards.length > 0) break;
                }

                console.log(`[infojobs-eval] ${cards.length} cards encontrados`);

                return cards.map(card => {
                    const linkEl = card.querySelector(
                        'h2 a, h3 a, [class*="title"] a, a[href*="/vaga/"], a[href*="/emprego/"]'
                    );
                    const compEl = card.querySelector(
                        '[class*="company"], [class*="employer"], [class*="empresa"], [class*="companyName"]'
                    );
                    const locEl  = card.querySelector(
                        '[class*="location"], [class*="locality"], [class*="local"], [class*="city"]'
                    );
                    const modalEl = card.querySelector(
                        '[class*="remote"], [class*="telework"], [class*="modalidade"]'
                    );
                    const link = linkEl?.href || linkEl?.getAttribute('href');
                    return {
                        vaga:        (linkEl?.textContent?.trim() || linkEl?.getAttribute('title') || '').trim(),
                        empresa:     compEl?.textContent?.trim() || '',
                        localizacao: locEl?.textContent?.trim()  || '',
                        modalidade:  modalEl?.textContent?.trim() || '',
                        link:        link
                            ? (link.startsWith('http') ? link : `https://www.infojobs.com.br${link}`)
                            : null,
                    };
                }).filter(j => j.vaga && j.link);
            });

            console.error(`[infojobs] Cards para "${keyword}": ${jobs.length}`);

            for (const job of jobs) {
                if (results.length >= maxResults) break;
                if (!job.link || seen.has(job.link)) continue;
                seen.add(job.link);
                results.push(normalize({
                    empresa:    job.empresa || 'Empresa não informada',
                    vaga:       job.vaga,
                    link_vaga:  job.link,
                    localizacao: job.localizacao || null,
                    modalidade:  job.modalidade  || null,
                }, 'infojobs'));
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
