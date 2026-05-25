// Scraper do LinkedIn Jobs usando Playwright + cookie file.
// Estratégia: URL com &f_TPR=r86400 (últimas 24h) + &sortBy=DD.
// A descrição completa de cada vaga é buscada em página separada.

import { chromium } from 'playwright';
import { ensureSession, refreshSession } from './session.js';
import { normalize } from './normalizer.js';

const DELAY_MIN = 800;
const DELAY_MAX = 2200;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => delay(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));

function buildSearchUrl(keyword, timeFilter, remoteOnly) {
    const params = new URLSearchParams({
        keywords: keyword,
        location: 'Brasil',
        sortBy: 'DD',
        f_TPR: timeFilter,
    });
    if (remoteOnly) params.set('f_WT', '2');
    return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

function isSessionExpired(url) {
    const u = url.toString();
    return u.includes('/login') || u.includes('/authwall') || u.includes('/checkpoint');
}

async function extractJobCards(page) {
    return page.evaluate(() => {
        const cards = [];
        // Seletores testados em 2026-05; o LinkedIn muda frequentemente
        const items = document.querySelectorAll([
            'li.jobs-search-results__list-item',
            'li.scaffold-layout__list-item',
            'div.job-card-container',
        ].join(','));

        for (const item of items) {
            try {
                const titleEl = item.querySelector([
                    'a.job-card-list__title',
                    'a.job-card-container__link',
                    'h3 a',
                    '.base-search-card__title a',
                ].join(','));
                const companyEl = item.querySelector([
                    'a.job-card-container__company-name',
                    'span.job-card-container__primary-description',
                    '.job-card-container__primary-description',
                    '.base-search-card__subtitle',
                    '.artdeco-entity-lockup__subtitle span',
                    '.job-card-list__company-name',
                    'h4 a',
                    '[class*="company-name"]',
                ].join(','));
                // Captura TODOS os metadata items (localização + tipo de trabalho ficam em elementos separados)
                const metaItems = [...item.querySelectorAll('.job-card-container__metadata-item')];
                const locationEl = metaItems.length === 0
                    ? item.querySelector('.job-search-card__location, .base-search-card__metadata')
                    : null;

                const href = titleEl?.href || titleEl?.closest('a')?.href || '';
                // Normaliza link para canonical /jobs/view/ID/
                const match = href.match(/\/jobs\/view\/(\d+)/);
                const link = match ? `https://www.linkedin.com/jobs/view/${match[1]}/` : href;

                if (!link) continue;

                // Junta todos os metadata items: o LinkedIn separa localização e tipo de trabalho
                // ex: ["São Paulo, SP" , "Remoto"] → "São Paulo, SP · Remoto"
                const localizacao = metaItems.length > 0
                    ? metaItems.map(el => el.textContent.trim()).filter(Boolean).join(' · ')
                    : locationEl?.textContent?.trim() || null;

                cards.push({
                    vaga:        titleEl?.textContent?.trim() || null,
                    empresa:     companyEl?.textContent?.trim() || null,
                    localizacao,
                    link_vaga:   link,
                });
            } catch { /* ignora card com erro de parse */ }
        }
        return cards;
    });
}

async function fetchJobDetail(page, link) {
    try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await randomDelay();

        // Aguarda descrição renderizar (LinkedIn carrega via JS)
        const descSel = [
            '.jobs-description__content',
            '.jobs-description-content__text',
            '.show-more-less-html__markup',
            '.jobs-box__html-content',
            '#job-details',
            '.description__text',
            '[class*="description"]',
        ].join(',');

        await page.waitForSelector(descSel, { timeout: 8_000 }).catch(() => {});

        return await page.evaluate(() => {
            // Empresa — seletores testados em 2026-05
            const companySels = [
                '.jobs-unified-top-card__company-name a',
                '.jobs-unified-top-card__company-name',
                '.job-details-jobs-unified-top-card__company-name a',
                '.job-details-jobs-unified-top-card__company-name',
                '.topcard__org-name-link',
                '.topcard__flavor a',
                '[class*="company-name"] a',
                '[class*="company-name"]',
            ];
            let empresa = null;
            for (const sel of companySels) {
                const t = document.querySelector(sel)?.innerText?.trim();
                if (t && t.length > 1) { empresa = t; break; }
            }

            // Descrição
            const descSels = [
                '.jobs-description__content',
                '.jobs-description-content__text',
                '.show-more-less-html__markup',
                '.jobs-box__html-content',
                '#job-details',
                '.description__text',
            ];
            let descricao = null;
            for (const sel of descSels) {
                const t = document.querySelector(sel)?.innerText?.trim();
                if (t && t.length > 50) { descricao = t; break; }
            }
            if (!descricao) {
                const candidates = [...document.querySelectorAll('section, article, div')];
                const best = candidates
                    .map(el => ({ el, len: (el.innerText || '').trim().length }))
                    .filter(({ len }) => len > 100 && len < 8000)
                    .sort((a, b) => b.len - a.len)[0];
                descricao = best?.el?.innerText?.trim() || null;
            }

            return { descricao, empresa };
        });
    } catch {
        return { descricao: null, empresa: null };
    }
}

export async function searchLinkedin({ keywords, timeFilter = 'r86400', maxResults = 30, remoteOnly = false }) {
    const { browser, context } = await ensureSession({ chromium });
    const page = await context.newPage();
    const seen = new Set();
    const results = [];

    try {
        for (const keyword of keywords) {
            if (results.length >= maxResults) break;

            const url = buildSearchUrl(keyword, timeFilter, remoteOnly);
            console.error(`[linkedin] Buscando: "${keyword}" → ${url}`);

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await randomDelay();

            if (isSessionExpired(page.url())) {
                throw new Error('Sessão LinkedIn expirada. Use clear_linkedin_session e tente novamente.');
            }

            // Aguarda cards carregarem (tenta dois seletores)
            await page.waitForSelector(
                'li.jobs-search-results__list-item, div.job-card-container, .base-search-card',
                { timeout: 15_000 }
            ).catch(() => {});

            // Scroll suave para carregar mais cards
            await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'smooth' }));
            await delay(1000);

            const cards = await extractJobCards(page);
            console.error(`[linkedin] Cards encontrados para "${keyword}": ${cards.length}`);

            for (const card of cards) {
                if (!card.link_vaga || seen.has(card.link_vaga)) continue;
                if (results.length >= maxResults) break;
                seen.add(card.link_vaga);

                await randomDelay();
                const detail = await fetchJobDetail(page, card.link_vaga);

                results.push(normalize({
                    empresa:    card.empresa || detail.empresa || 'Empresa não informada',
                    vaga:       card.vaga,
                    link_vaga:  card.link_vaga,
                    descricao:  detail.descricao,
                    localizacao: card.localizacao,
                }, 'linkedin'));
            }
        }

        await refreshSession(context);
    } finally {
        await browser.close();
    }

    console.error(`[linkedin] Total coletado: ${results.length}`);
    return results;
}
