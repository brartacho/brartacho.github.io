// Scraper do Workana (workana.com) via Playwright.
// Plataforma de freelance BR/LATAM para projetos de TI e criação.
// URL: https://www.workana.com/jobs?query=KEYWORD&category=it-programming&language=pt
// Tipo de contratação: Freelancer (não CLT/PJ)
//
// O HTML do Workana traz cards renderizados via Vue.js — o fetch+cheerio
// retorna a casca da página sem cards. Por isso usamos Playwright com stealth
// para acessar o DOM após hidratação. Cards têm classe .project-item.js-project.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { normalize } from './normalizer.js';

chromium.use(StealthPlugin());

const BASE_URL = 'https://www.workana.com';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function extractJobs(page) {
    return page.evaluate(() => {
        const items = [...document.querySelectorAll('.project-item.js-project, .project-item, .js-project')];

        const seen = new Set();
        const out  = [];
        for (const item of items) {
            const linkEl  = item.querySelector('a[href*="/job/"], .project-title a, h2 a, h3 a');
            const link    = linkEl?.href;
            if (!link || seen.has(link)) continue;
            seen.add(link);

            const titleEl = item.querySelector('.project-title, h2, h3');
            const title   = (titleEl?.textContent || linkEl?.textContent || '').trim();
            if (!title) continue;

            // Empresa: o nome do cliente aparece no atributo title da imagem do
            // avatar (ex: title="Excellence Q. T."). É mais limpo que .project-author
            // que mistura metadados de pagamento.
            const avatarImg = item.querySelector('.project-author img, .author-avatar img');
            const company   = avatarImg?.getAttribute('title')?.trim() ||
                              avatarImg?.getAttribute('alt')?.replace(/^Freelancer\s+/i, '').trim() ||
                              null;

            // Descrição: usa .project-details (texto da vaga), não .project-body
            // (que inclui metadata de tempo/propostas).
            const descEl = item.querySelector('.project-details');
            const desc   = descEl?.textContent?.trim().slice(0, 300) || null;

            out.push({ link, title, company, desc });
        }
        return out;
    });
}

export async function searchWorkana({ keywords, maxResults = 20 }) {
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
            console.error(`[workana] Buscando: "${keyword}"`);

            const params = new URLSearchParams({
                query:    keyword,
                category: 'it-programming',
                language: 'pt',
            });
            const url = `${BASE_URL}/jobs?${params}`;

            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            } catch (e) {
                console.error(`[workana] Timeout em "${keyword}": ${e.message}`);
                continue;
            }
            try {
                await page.waitForSelector('.project-item, .js-project', { timeout: 10_000 });
            } catch {
                // Sem resultados — segue
            }
            await new Promise(r => setTimeout(r, 1500));

            const jobs = await extractJobs(page);
            console.error(`[workana] Jobs para "${keyword}": ${jobs.length}`);

            for (const job of jobs) {
                if (results.length >= maxResults) break;
                if (!job.link || seen.has(job.link)) continue;
                seen.add(job.link);

                results.push(normalize({
                    empresa:          job.company || 'Cliente Workana',
                    vaga:             job.title,
                    link_vaga:        job.link,
                    descricao:        job.desc,
                    modalidade:       'Remota',
                    tipo_contratacao: 'Freelancer',
                    localizacao:      'Brasil / LATAM',
                }, 'workana'));
            }
            await new Promise(r => setTimeout(r, 800 + Math.random() * 600));
        }

        await page.close();
    } catch (e) {
        console.error(`[workana] Erro fatal: ${e.message}`);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    console.error(`[workana] Total coletado: ${results.length}`);
    return results;
}
