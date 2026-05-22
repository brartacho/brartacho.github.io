// Scraper de empregos.maringa.com via Playwright (real Chrome).
// O site usa Cloudflare — fetch simples é bloqueado com 403.
// Usa channel:'chrome' para contornar a proteção.

import { chromium } from 'playwright';
import { normalize } from './normalizer.js';

const BASE_URL = 'https://empregos.maringa.com';

// Extrai localização da última linha de texto que contém UF (PR, SP, MG…)
function parseLocation(lines) {
    const ufRe = /\b(PR|SP|MG|RJ|RS|SC|GO|BA|CE|PE|AM|PA|DF|ES|MT|MS|TO|RO|AC|RN|PB|AL|SE|PI|MA|AP|RR)\b/;
    const loc = lines.find(l => ufRe.test(l));
    if (!loc) return 'Paraná';
    // Remove data no final (dd/mm/aaaa)
    return loc.replace(/\s+\d{2}\/\d{2}\/\d{4}\s*$/, '').trim();
}

export async function searchMaringa({ keywords, maxResults = 15 }) {
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

            console.error(`[maringa] Buscando: "${keyword}"`);
            const url = `${BASE_URL}/?text=${encodeURIComponent(keyword)}&ordem=publicacao`;

            try {
                await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
            } catch {
                // networkidle pode expirar — continua mesmo assim
            }
            await new Promise(r => setTimeout(r, 1000));

            const cards = await page.evaluate(() =>
                [...document.querySelectorAll('.card-anuncio')].map(card => {
                    const lines = card.innerText.split('\n').map(l => l.trim()).filter(Boolean);
                    const linkEl = card.querySelector('a[href]');
                    return {
                        title:  card.querySelector('b.flex-wrap')?.textContent?.trim() || lines[0],
                        company: lines[1] || null,
                        lines,
                        link:   linkEl?.href || null,
                    };
                }).filter(c => c.title && c.link)
            );

            console.error(`[maringa] Cards para "${keyword}": ${cards.length}`);

            for (const card of cards) {
                if (results.length >= maxResults) break;
                if (!card.link || seen.has(card.link)) continue;
                seen.add(card.link);

                results.push(normalize({
                    empresa:    card.company || 'Empresa não informada',
                    vaga:       card.title,
                    link_vaga:  card.link,
                    descricao:  null,
                    localizacao: parseLocation(card.lines),
                }, 'maringa'));
            }

            await new Promise(r => setTimeout(r, 800 + Math.random() * 800));
        }

        await page.close();
    } catch (e) {
        console.error(`[maringa] Erro fatal: ${e.message}`);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    console.error(`[maringa] Total coletado: ${results.length}`);
    return results;
}
