// Scraper de empregos.maringa.com.
// Site usa Cloudflare Turnstile nas páginas individuais — bypass via stealth plugin.
// Listagem: cards via .card-anuncio. Detalhe: p.description / ul.description.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { normalize } from './normalizer.js';

chromium.use(StealthPlugin());

const BASE_URL = 'https://empregos.maringa.com';

function parseLocation(lines) {
    const ufRe = /\b(PR|SP|MG|RJ|RS|SC|GO|BA|CE|PE|AM|PA|DF|ES|MT|MS|TO|RO|AC|RN|PB|AL|SE|PI|MA|AP|RR)\b/;
    const loc = lines.find(l => ufRe.test(l));
    if (!loc) return 'Paraná';
    return loc.replace(/\s+\d{2}\/\d{2}\/\d{4}\s*$/, '').trim();
}

async function fetchJobDescription(page, url) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        // Aguarda Cloudflare resolver (com stealth, normalmente <1s)
        try {
            await page.waitForFunction(
                () => !/um momento|just a moment|attention required/i.test(document.title),
                { timeout: 15_000 }
            );
        } catch {
            console.error(`[maringa] Challenge não resolveu para ${url}`);
            return null;
        }
        await new Promise(r => setTimeout(r, 500));

        return await page.evaluate(() => {
            const all = document.body?.innerText || '';

            // 1) Regex no body entre "Descrição:" e marcadores de fim
            const m = all.match(/Descri[çc][ãa]o:?\s*([\s\S]*?)(?=Enviar Curr[íi]culo|Compartilhar|Voltar para|©|$)/i);
            if (m && m[1].trim().length > 50) return m[1].trim();

            // 2) Seletores semânticos sem cookies
            const SELECTORS = [
                'p.description', 'ul.description',
                '.job-description', '.vaga-descricao', '.descricao',
                'section.description', 'div.description',
                '[class*="descri"]', '[id*="descri"]',
                'article p', 'main p',
            ];
            for (const sel of SELECTORS) {
                const blocks = [...document.querySelectorAll(sel)]
                    .map(el => el.innerText?.trim())
                    .filter(t => t && t.length > 30 && !/cookies|essenciais|privacidade/i.test(t));
                if (blocks.length) return blocks.join('\n');
            }

            // 3) Último recurso: maior bloco de texto da página
            const paras = [...document.querySelectorAll('p, li')]
                .map(el => el.innerText?.trim())
                .filter(t => t && t.length > 80 && !/cookies|essenciais/i.test(t));
            return paras.length ? paras.slice(0, 10).join('\n') : null;
        });
    } catch (e) {
        console.error(`[maringa] Erro ao buscar descrição ${url}: ${e.message}`);
        return null;
    }
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

        const listPage = await ctx.newPage();
        const detailPage = await ctx.newPage();

        // Coleta cards de todas as keywords primeiro
        const allCards = [];
        for (const keyword of keywords) {
            console.error(`[maringa] Buscando: "${keyword}"`);
            const url = `${BASE_URL}/?text=${encodeURIComponent(keyword)}&estado=&cidade=&ordem=publicacao&area=18&faixa_salarial=`;

            try {
                await listPage.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
            } catch {
                // networkidle pode timeout em sites lentos — tenta com load
                try {
                    await listPage.goto(url, { waitUntil: 'load', timeout: 25_000 });
                } catch {
                    console.error(`[maringa] Timeout total em "${keyword}", pulando`);
                    continue;
                }
            }
            await new Promise(r => setTimeout(r, 2000));

            // Detecta seletores disponíveis para debug
            const pageInfo = await listPage.evaluate(() => ({
                title: document.title,
                cardAnuncio: document.querySelectorAll('.card-anuncio').length,
                cardJob: document.querySelectorAll('.card-job, .job-card, [class*="card"]').length,
                allLinks: document.querySelectorAll('a[href*="/emprego/"], a[href*="/vaga/"]').length,
            }));
            console.error(`[maringa] Página "${keyword}": title="${pageInfo.title}" .card-anuncio=${pageInfo.cardAnuncio} outros-cards=${pageInfo.cardJob} links-vaga=${pageInfo.allLinks}`);

            const cards = await listPage.evaluate(() => {
                // Seletor primário
                let items = [...document.querySelectorAll('.card-anuncio')];

                // Fallback: links diretos para páginas de emprego
                if (!items.length) {
                    const linkEls = [...document.querySelectorAll('a[href*="/emprego/"], a[href*="/vaga/"]')];
                    return linkEls.map(a => ({
                        title:   a.textContent?.trim() || a.href,
                        company: null,
                        lines:   [a.textContent?.trim()].filter(Boolean),
                        link:    a.href,
                    })).filter(c => c.title && c.link);
                }

                return items.map(card => {
                    const lines = card.innerText.split('\n').map(l => l.trim()).filter(Boolean);
                    const linkEl = card.querySelector('a[href]');
                    return {
                        title:   card.querySelector('b.flex-wrap, h2, h3, .title, strong')?.textContent?.trim() || lines[0],
                        company: lines[1] || null,
                        lines,
                        link:    linkEl?.href || null,
                    };
                }).filter(c => c.title && c.link);
            });

            console.error(`[maringa] Cards para "${keyword}": ${cards.length}`);

            // Se keyword não retornou nada, tenta sem texto (só área 18) — uma vez por sessão
            if (!cards.length && keyword === keywords[0] && allCards.length === 0) {
                const urlSemText = `${BASE_URL}/?text=&estado=&cidade=&ordem=publicacao&area=18&faixa_salarial=`;
                console.error(`[maringa] Sem resultados para "${keyword}", tentando sem filtro de texto`);
                try { await listPage.goto(urlSemText, { waitUntil: 'load', timeout: 25_000 }); } catch {}
                await new Promise(r => setTimeout(r, 2000));
                const fallbackCards = await listPage.evaluate(() =>
                    [...document.querySelectorAll('.card-anuncio, a[href*="/emprego/"]')].map(el => {
                        const card = el.closest('.card-anuncio') || el;
                        const lines = card.innerText?.split('\n').map(l => l.trim()).filter(Boolean) || [];
                        const linkEl = card.querySelector?.('a[href]') || (el.tagName === 'A' ? el : null);
                        return { title: lines[0] || linkEl?.textContent?.trim(), company: lines[1] || null, lines, link: linkEl?.href || null };
                    }).filter(c => c.title && c.link)
                );
                console.error(`[maringa] Fallback sem texto: ${fallbackCards.length} cards`);
                fallbackCards.slice(0, maxResults).forEach(c => { if (!seen.has(c.link)) { seen.add(c.link); allCards.push(c); } });
                break;
            }

            for (const card of cards) {
                if (allCards.length >= maxResults) break;
                if (!card.link || seen.has(card.link)) continue;
                seen.add(card.link);
                allCards.push(card);
            }
            if (allCards.length >= maxResults) break;

            await new Promise(r => setTimeout(r, 600 + Math.random() * 600));
        }

        // Busca descrição de cada card
        for (let i = 0; i < allCards.length; i++) {
            const card = allCards[i];
            const descricao = await fetchJobDescription(detailPage, card.link);
            if (descricao) {
                console.error(`[maringa] (${i + 1}/${allCards.length}) descrição: ${descricao.length} chars`);
            } else {
                console.error(`[maringa] (${i + 1}/${allCards.length}) sem descrição`);
            }

            // Detecta modalidade explícita no card antes de fallback por descrição
            const cardText = card.lines.join(' ');
            const hasRemote = /remot[oa]|home\s*office/i.test(cardText);
            const hasHybrid = /h[ií]brid[oa]/i.test(cardText);
            // Maringá é board local — presencial é o padrão quando não há indicador
            const modalidade = hasHybrid ? 'Híbrida' : hasRemote ? 'Remota' : 'Presencial';

            results.push(normalize({
                empresa:     card.company || 'Empresa não informada',
                vaga:        card.title,
                link_vaga:   card.link,
                descricao,
                localizacao: parseLocation(card.lines),
                modalidade,
            }, 'maringa'));

            await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
        }

        await listPage.close();
        await detailPage.close();
    } catch (e) {
        console.error(`[maringa] Erro fatal: ${e.message}`);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    console.error(`[maringa] Total coletado: ${results.length}`);
    return results;
}
