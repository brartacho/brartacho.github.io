// Scraper do Vagas.com.br via Playwright + stealth.
// URL: https://www.vagas.com.br/vagas-de-KEYWORD
// Maior board de vagas do Brasil. Anti-bot via Cloudflare.
// Usa mesmo padrão do infojobs.js (playwright-extra + stealth).

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { normalize } from './normalizer.js';

chromium.use(StealthPlugin());

const BASE_URL = 'https://www.vagas.com.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function slugify(keyword) {
    return keyword
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-');
}

async function extractJobsFromPage(page) {
    return page.evaluate(() => {
        // Vagas.com.br usa <li class="vaga"> com h2.cargo
        const items = [
            ...document.querySelectorAll('li.vaga, .vagaResult, [class*="vaga-"], article[class*="job"]'),
        ];

        if (items.length) {
            return items.slice(0, 40).map(el => {
                const linkEl   = el.querySelector('a.link-detalhes-vaga, a[href*="/vagas/"], h2 a, h3 a, a[href]');
                const titleEl  = el.querySelector('h2.cargo, h2, h3, .cargo, .title');
                const compEl   = el.querySelector('.empresa, .company, [class*="empresa"]');
                const locEl    = el.querySelector('.local, .localidade, .location, [class*="local"]');
                const typeEl   = el.querySelector('.tipo, [class*="tipo"], .contract-type');
                const link     = linkEl?.href || null;
                return {
                    link,
                    title:    titleEl?.textContent?.trim() || linkEl?.textContent?.trim() || null,
                    company:  compEl?.textContent?.trim() || null,
                    location: locEl?.textContent?.trim() || null,
                    type:     typeEl?.textContent?.trim() || null,
                };
            }).filter(j => j.link && j.title);
        }

        // Fallback: links diretos para /vagas/<slug>
        return [...document.querySelectorAll('a[href*="/vagas/"]')]
            .filter(a => a.href && !a.href.endsWith('/vagas') && !a.href.endsWith('/vagas/'))
            .slice(0, 40)
            .map(a => ({
                link:    a.href,
                title:   a.textContent?.trim() || null,
                company: null, location: null, type: null,
            }))
            .filter(j => j.link && j.title);
    });
}

export async function searchVagas({ keywords, maxResults = 20 }) {
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

        // Bloqueia assets pesados para acelerar o carregamento
        await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,mp3}', r => r.abort());

        for (const keyword of keywords) {
            if (results.length >= maxResults) break;
            console.error(`[vagas] Buscando: "${keyword}"`);

            const slug = slugify(keyword);
            const url  = `${BASE_URL}/vagas-de-${slug}`;

            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

                // Aguarda Cloudflare resolver
                await page.waitForFunction(
                    () => !/um momento|just a moment|attention required/i.test(document.title),
                    { timeout: 15_000 }
                ).catch(() => {});

                await new Promise(r => setTimeout(r, 2000));
            } catch (e) {
                console.error(`[vagas] Erro ao carregar "${keyword}": ${e.message}`);
                continue;
            }

            const pageTitle = await page.title().catch(() => '');
            if (/not found|404|erro/i.test(pageTitle)) {
                console.error(`[vagas] Página não encontrada para "${keyword}"`);
                continue;
            }

            const jobs = await extractJobsFromPage(page);
            console.error(`[vagas] Jobs para "${keyword}": ${jobs.length}`);

            for (const job of jobs) {
                if (results.length >= maxResults) break;
                if (!job.link || seen.has(job.link)) continue;
                seen.add(job.link);

                results.push(normalize({
                    empresa:          job.company || 'Empresa não informada',
                    vaga:             job.title,
                    link_vaga:        job.link,
                    localizacao:      job.location || 'Brasil',
                    tipo_contratacao: job.type || null,
                }, 'vagas'));
            }
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 800));
        }

        await page.close();
    } catch (e) {
        console.error(`[vagas] Erro fatal: ${e.message}`);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    console.error(`[vagas] Total coletado: ${results.length}`);
    return results;
}
