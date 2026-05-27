// Scraper do Trampos.co via Playwright.
// URL de busca: https://trampos.co/oportunidades?search=KEYWORD
// O Trampos é uma SPA (Ember.js) — fetch+cheerio não traz os cards,
// só a casca da página. Por isso usamos Playwright.
// Foco em vagas tech/criativas no Brasil.
//
// Cards: .opportunity-box com data-opportunity-id; link relativo /oportunidades/<id>.
// Título em <h4>; localização e logo em divs internas.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { normalize } from './normalizer.js';

chromium.use(StealthPlugin());

const BASE_URL = 'https://trampos.co';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function extractJobs(page) {
    return page.evaluate(() => {
        const items = [...document.querySelectorAll('.opportunity-box')];
        const seen  = new Set();
        const out   = [];

        for (const item of items) {
            const a    = item.querySelector('a[href*="/oportunidades/"]');
            const href = a?.href;
            if (!href || seen.has(href)) continue;
            seen.add(href);

            const titleEl = item.querySelector('h4, h3, h2');
            const title   = (titleEl?.textContent || '').trim();
            if (!title) continue;

            // Empresa: alt do logo, ou — caso ausente — slug do arquivo do logo
            // (ex: .../artium_solues_logo.jpg → "Artium Solues").
            const logoImg = item.querySelector('.logo img');
            const logoAlt = logoImg?.getAttribute('alt') || '';
            let company = logoAlt.replace(/^Logo\s+(da|do)?\s*/i, '').trim() || null;
            if (!company && logoImg?.src) {
                const m = logoImg.src.match(/\/([^/]+?)_logo\.(?:png|jpg|jpeg|svg|webp)/i);
                if (m) {
                    company = m[1].replace(/[-_]+/g, ' ')
                                  .replace(/\b\w/g, c => c.toUpperCase())
                                  .trim() || null;
                }
            }

            // .location contém badge .type (ex: "Emprego") + cidade.
            // Remove o badge e extrai só a localização real.
            let location = null;
            const locationEl = item.querySelector('.location');
            if (locationEl) {
                const clone = locationEl.cloneNode(true);
                clone.querySelectorAll('.type').forEach(n => n.remove());
                location = clone.textContent.replace(/\s+/g, ' ').trim() || null;
            }

            const type = item.getAttribute('data-type') || null;

            out.push({ link: href, title, company, location, type });
        }
        return out;
    });
}

export async function searchTrampos({ keywords, maxResults = 20 }) {
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
            console.error(`[trampos] Buscando: "${keyword}"`);

            const url = `${BASE_URL}/oportunidades?search=${encodeURIComponent(keyword)}`;
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            } catch (e) {
                console.error(`[trampos] Timeout em "${keyword}": ${e.message}`);
                continue;
            }
            try {
                await page.waitForSelector('.opportunity-box', { timeout: 10_000 });
            } catch {
                // Sem resultados — segue
            }
            await new Promise(r => setTimeout(r, 1500));

            const jobs = await extractJobs(page);
            console.error(`[trampos] Jobs para "${keyword}": ${jobs.length}`);

            for (const job of jobs) {
                if (results.length >= maxResults) break;
                if (!job.link || seen.has(job.link)) continue;
                seen.add(job.link);

                results.push(normalize({
                    empresa:     job.company || 'Empresa não informada',
                    vaga:        job.title,
                    link_vaga:   job.link,
                    localizacao: job.location || 'Brasil',
                    tipo_contratacao: job.type === 'emprego' ? 'CLT' : (job.type || null),
                }, 'trampos'));
            }
            await new Promise(r => setTimeout(r, 800 + Math.random() * 600));
        }

        await page.close();
    } catch (e) {
        console.error(`[trampos] Erro fatal: ${e.message}`);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    console.error(`[trampos] Total coletado: ${results.length}`);
    return results;
}
