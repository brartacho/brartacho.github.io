// Scraper do JS Remotely (jsremotely.com) via fetch + Cheerio.
// Site estático focado em vagas JavaScript remote (internacional).
// URL: https://jsremotely.com/?keywords=KEYWORD

import { load } from 'cheerio';
import { normalize } from './normalizer.js';

const BASE_URL = 'https://jsremotely.com';

const HEADERS = {
    'accept':          'text/html,application/xhtml+xml',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

async function fetchPage(url) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

function extractJobs($) {
    const results = [];

    // Seletores candidatos para JS Remotely (site estático/simples)
    const selectors = [
        '.job, .job-item, [class*="job"]',
        'article',
        '.list-item, li[class]',
    ];

    for (const sel of selectors) {
        const items = $(sel).filter((_, el) => $(el).find('a').length > 0);
        if (!items.length) continue;

        items.each((_, el) => {
            const $el    = $(el);
            const linkEl = $el.find(
                'a[href*="/jobs/"], a[href*="/job/"], a[href*="jsremotely.com"], h2 a, h3 a, h1 a'
            ).first();
            const link    = linkEl.attr('href') || $el.find('a').first().attr('href');
            const title   = $el.find('h1, h2, h3, h4, .title, [class*="title"]').first().text().trim()
                         || linkEl.text().trim();
            const company = $el.find('.company, [class*="company"], [class*="employer"]').first().text().trim();
            const tags    = $el.find('.tag, [class*="tag"], [class*="tech"]')
                              .map((_, t) => $(t).text().trim()).get().join(', ');

            if (!link || !title) return;
            const fullLink = link.startsWith('http') ? link : `${BASE_URL}${link}`;
            results.push({ fullLink, title, company, tags });
        });

        if (results.length) break;
    }

    // Último recurso: qualquer link para /jobs/<slug>
    if (!results.length) {
        $('a[href*="/jobs/"]').each((_, a) => {
            const href = $(a).attr('href') || '';
            if (!href || href === '/jobs' || href === '/jobs/') return;
            const fullLink = href.startsWith('http') ? href : `${BASE_URL}${href}`;
            const title    = $(a).text().trim();
            if (!title) return;
            results.push({ fullLink, title, company: null, tags: null });
        });
    }

    return results;
}

export async function searchJsRemotely({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;
        console.error(`[jsremotely] Buscando: "${keyword}"`);

        const url = `${BASE_URL}/?keywords=${encodeURIComponent(keyword)}`;
        let html;
        try {
            html = await fetchPage(url);
        } catch (e) {
            // Fallback: busca sem parâmetro (pega todos) para filtragem client-side
            try {
                html = await fetchPage(BASE_URL);
            } catch (e2) {
                console.error(`[jsremotely] Erro ao buscar "${keyword}": ${e2.message}`);
                continue;
            }
        }

        const $    = load(html);
        const jobs = extractJobs($);
        console.error(`[jsremotely] Jobs para "${keyword}": ${jobs.length}`);

        const kw = keyword.toLowerCase();
        for (const job of jobs) {
            if (results.length >= maxResults) break;
            if (!job.fullLink || seen.has(job.fullLink)) continue;

            // Filtragem client-side quando buscou todos os jobs
            const hay = `${job.title} ${job.company ?? ''} ${job.tags ?? ''}`.toLowerCase();
            if (!hay.includes(kw)) continue;

            seen.add(job.fullLink);
            results.push(normalize({
                empresa:   job.company || 'Empresa não informada',
                vaga:      job.title,
                link_vaga: job.fullLink,
                descricao: job.tags || null,
                modalidade: 'Remota',
            }, 'jsremotely'));
        }
    }

    console.error(`[jsremotely] Total coletado: ${results.length}`);
    return results;
}
