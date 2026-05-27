// Scraper do Trampos.co via fetch + Cheerio.
// URL de busca: https://trampos.co/oportunidades?search=KEYWORD
// Site Rails — server-side rendering, sem necessidade de Playwright.
// Foco em vagas tech/criativas no Brasil.

import { load } from 'cheerio';
import { normalize } from './normalizer.js';

const BASE_URL = 'https://trampos.co';

const HEADERS = {
    'accept':          'text/html,application/xhtml+xml',
    'accept-language': 'pt-BR,pt;q=0.9',
    'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

async function fetchPage(url) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

function extractJobs($) {
    const results = [];

    // Seletores primários (Trampos.co, layout típico de Rails)
    const candidates = [
        '.opportunity, .oportunidade, .job-item, .job_listing',
        'article[class*="opportunity"], article[class*="oportunidade"]',
        '[class*="opportunity-card"], [class*="job-card"]',
        '.list-group-item, .media',
    ];

    for (const sel of candidates) {
        const items = $(sel);
        if (!items.length) continue;

        items.each((_, el) => {
            const $el   = $(el);
            const linkEl = $el.find('a[href*="/oportunidades/"], a[href*="/jobs/"], h2 a, h3 a').first();
            const link  = linkEl.attr('href');
            if (!link) return;

            const fullLink = link.startsWith('http') ? link : `${BASE_URL}${link}`;
            const title    = linkEl.text().trim()
                          || $el.find('h1, h2, h3, h4, .title, .name').first().text().trim();
            const company  = $el.find('.company, .empresa, [class*="company"]').first().text().trim();
            const location = $el.find('.location, .cidade, [class*="location"]').first().text().trim();
            const modal    = $el.find('[class*="remot"], [class*="modal"]').first().text().trim();

            if (!title) return;
            results.push({ fullLink, title, company, location, modal });
        });

        if (results.length) break;
    }

    // Fallback: qualquer link para /oportunidades/<slug>
    if (!results.length) {
        $('a[href*="/oportunidades/"]').each((_, a) => {
            const href = $(a).attr('href') || '';
            if (!href || href.endsWith('/oportunidades') || href.endsWith('/oportunidades/')) return;
            const fullLink = href.startsWith('http') ? href : `${BASE_URL}${href}`;
            const title    = $(a).text().trim();
            if (!title) return;
            results.push({ fullLink, title, company: null, location: null, modal: null });
        });
    }

    return results;
}

export async function searchTrampos({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;
        console.error(`[trampos] Buscando: "${keyword}"`);

        // Trampos usa /oportunidades com ?search= ou ?q=
        const urls = [
            `${BASE_URL}/oportunidades?search=${encodeURIComponent(keyword)}`,
            `${BASE_URL}/oportunidades?q=${encodeURIComponent(keyword)}`,
        ];

        let html = null;
        for (const url of urls) {
            try {
                html = await fetchPage(url);
                break;
            } catch (e) {
                console.error(`[trampos] Erro ${url}: ${e.message}`);
            }
        }
        if (!html) continue;

        const $ = load(html);
        const jobs = extractJobs($);
        console.error(`[trampos] Jobs para "${keyword}": ${jobs.length}`);

        for (const job of jobs) {
            if (results.length >= maxResults) break;
            if (!job.fullLink || seen.has(job.fullLink)) continue;
            seen.add(job.fullLink);

            results.push(normalize({
                empresa:    job.company || 'Empresa não informada',
                vaga:       job.title,
                link_vaga:  job.fullLink,
                modalidade: job.modal || null,
                localizacao: job.location || 'Brasil',
            }, 'trampos'));
        }
    }

    console.error(`[trampos] Total coletado: ${results.length}`);
    return results;
}
