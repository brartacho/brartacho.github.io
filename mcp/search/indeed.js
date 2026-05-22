// Scraper do Indeed Brasil via Playwright (real Chrome).
// O RSS feed e o site têm proteção Cloudflare — fetch simples retorna 403.
// Usa channel:'chrome' para contornar. Detecta bloqueio e falha de forma graciosa.

import { chromium } from 'playwright';
import { normalize } from './normalizer.js';

export async function searchIndeed({ keywords, maxResults = 20 }) {
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
            viewport: { width: 1280, height: 800 },
            locale: 'pt-BR',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });

        const page = await ctx.newPage();

        for (const keyword of keywords) {
            if (results.length >= maxResults) break;

            console.error(`[indeed] Buscando: "${keyword}"`);
            const url = `https://br.indeed.com/jobs?q=${encodeURIComponent(keyword)}&l=Brasil&sort=date`;

            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            } catch {
                console.error(`[indeed] Timeout ao navegar para "${keyword}"`);
                continue;
            }

            await new Promise(r => setTimeout(r, 3000));

            // Detecta bloqueio por Cloudflare / Indeed
            const title = await page.title();
            if (title.includes('Blocked') || title.includes('Security') || title.includes('Error')) {
                console.error(`[indeed] Bloqueado para "${keyword}" (título: ${title})`);
                continue;
            }

            const jobs = await page.evaluate(() => {
                const cards = [...document.querySelectorAll('.job_seen_beacon')];
                return cards.map(card => {
                    const titleEl   = card.querySelector('h2[class*="jobTitle"] a');
                    const titleSpan = card.querySelector('h2[class*="jobTitle"] span[title]')
                                   || card.querySelector('h2[class*="jobTitle"] a span');
                    const companyEl = card.querySelector('[data-testid="company-name"]')
                                   || card.querySelector('[class*="companyName"]');
                    const locEl     = card.querySelector('[data-testid="text-location"]')
                                   || card.querySelector('[class*="companyLocation"]');
                    const jk = (titleEl?.href || titleEl?.getAttribute('href') || '').match(/jk=([a-f0-9]{16,})/)?.[1];
                    return {
                        vaga:       titleSpan?.textContent?.trim() || titleSpan?.getAttribute('title'),
                        empresa:    companyEl?.textContent?.trim(),
                        localizacao: locEl?.textContent?.trim(),
                        link:       jk ? `https://br.indeed.com/viewjob?jk=${jk}` : null,
                    };
                }).filter(j => j.vaga && j.link);
            });

            console.error(`[indeed] Jobs para "${keyword}": ${jobs.length}`);

            for (const job of jobs) {
                if (results.length >= maxResults) break;
                if (!job.link || seen.has(job.link)) continue;
                seen.add(job.link);

                results.push(normalize({
                    empresa:    job.empresa || 'Empresa não informada',
                    vaga:       job.vaga,
                    link_vaga:  job.link,
                    descricao:  null,
                    localizacao: job.localizacao,
                }, 'indeed'));
            }

            await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
        }

        await page.close();
    } catch (e) {
        console.error(`[indeed] Erro fatal: ${e.message}`);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    console.error(`[indeed] Total coletado: ${results.length}`);
    return results;
}
