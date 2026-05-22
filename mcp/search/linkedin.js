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
                    '.job-card-container__primary-description',
                    '.base-search-card__subtitle',
                    'h4 a',
                ].join(','));
                const locationEl = item.querySelector([
                    '.job-card-container__metadata-item',
                    '.job-search-card__location',
                    '.base-search-card__metadata',
                ].join(','));

                const href = titleEl?.href || titleEl?.closest('a')?.href || '';
                // Normaliza link para canonical /jobs/view/ID/
                const match = href.match(/\/jobs\/view\/(\d+)/);
                const link = match ? `https://www.linkedin.com/jobs/view/${match[1]}/` : href;

                if (!link) continue;
                cards.push({
                    vaga:       titleEl?.textContent?.trim() || null,
                    empresa:    companyEl?.textContent?.trim() || null,
                    localizacao: locationEl?.textContent?.trim() || null,
                    link_vaga:  link,
                });
            } catch { /* ignora card com erro de parse */ }
        }
        return cards;
    });
}

async function fetchJobDescription(page, link) {
    try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await randomDelay();

        return page.evaluate(() => {
            const el = document.querySelector([
                '.jobs-description-content__text',
                '.jobs-description__content',
                '.description__text',
                '#job-details',
            ].join(','));
            return el?.innerText?.trim() || null;
        });
    } catch {
        return null;
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
                const descricao = await fetchJobDescription(page, card.link_vaga);

                results.push(normalize({
                    empresa:    card.empresa || 'Empresa não informada',
                    vaga:       card.vaga,
                    link_vaga:  card.link_vaga,
                    descricao,
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
