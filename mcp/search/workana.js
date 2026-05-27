// Scraper do Workana (workana.com) via fetch + Cheerio.
// Plataforma de freelance BR/LATAM para projetos de TI e criação.
// URL: https://www.workana.com/jobs?query=KEYWORD&category=it-programming&language=pt
// Tipo de contratação: Freelancer (não CLT/PJ)

import { load } from 'cheerio';
import { normalize } from './normalizer.js';

const BASE_URL = 'https://www.workana.com';

const HEADERS = {
    'accept':          'text/html,application/xhtml+xml',
    'accept-language': 'pt-BR,pt;q=0.9',
    'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'referer':         'https://www.workana.com/',
};

async function fetchPage(url) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

function extractJobs($) {
    const results = [];

    // Workana usa <div class="job-item"> ou <article class="project">
    const selectors = [
        '.job-item, .project-item, [class*="job-item"]',
        'article[class*="project"], article[class*="job"]',
        '.list-item[class*="project"], .project',
        'li[class*="project"], li[class*="job"]',
    ];

    for (const sel of selectors) {
        const items = $(sel).filter((_, el) => $(el).find('a').length > 0);
        if (!items.length) continue;

        items.each((_, el) => {
            const $el     = $(el);
            const linkEl  = $el.find('h2 a, h3 a, a[class*="title"], a[href*="/job/"], a[href*="/project/"]').first();
            const link    = linkEl.attr('href') || $el.find('a').first().attr('href');
            if (!link) return;

            const fullLink  = link.startsWith('http') ? link : `${BASE_URL}${link}`;
            const title     = linkEl.text().trim() || $el.find('h2, h3').first().text().trim();
            const company   = $el.find('.client, .company, [class*="client"]').first().text().trim();
            const budget    = $el.find('.budget, .price, [class*="budget"]').first().text().trim();
            const category  = $el.find('.category, [class*="category"]').first().text().trim();
            const desc      = $el.find('.description, p').first().text().trim().slice(0, 300) || null;

            if (!title) return;
            results.push({ fullLink, title, company, budget, category, desc });
        });

        if (results.length) break;
    }

    // Fallback: links para /job/ ou /project/
    if (!results.length) {
        $('a[href*="/job/"], a[href*="/jobs/"]').each((_, a) => {
            const href = $(a).attr('href') || '';
            if (!href || /\/(jobs)\/?$/.test(href)) return;
            const fullLink = href.startsWith('http') ? href : `${BASE_URL}${href}`;
            const title = $(a).text().trim();
            if (!title) return;
            results.push({ fullLink, title, company: null, budget: null, category: null, desc: null });
        });
    }

    return results;
}

export async function searchWorkana({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;
        console.error(`[workana] Buscando: "${keyword}"`);

        const params = new URLSearchParams({
            query:    keyword,
            category: 'it-programming',
            language: 'pt',
        });
        const url = `${BASE_URL}/jobs?${params}`;

        let html;
        try {
            html = await fetchPage(url);
        } catch (e) {
            // Tenta sem filtro de categoria
            try {
                html = await fetchPage(`${BASE_URL}/jobs?query=${encodeURIComponent(keyword)}&language=pt`);
            } catch (e2) {
                console.error(`[workana] Erro ao buscar "${keyword}": ${e2.message}`);
                continue;
            }
        }

        const $    = load(html);
        const jobs = extractJobs($);
        console.error(`[workana] Jobs para "${keyword}": ${jobs.length}`);

        for (const job of jobs) {
            if (results.length >= maxResults) break;
            if (!job.fullLink || seen.has(job.fullLink)) continue;
            seen.add(job.fullLink);

            results.push(normalize({
                empresa:          job.company || 'Cliente Workana',
                vaga:             job.title,
                link_vaga:        job.fullLink,
                descricao:        job.desc,
                modalidade:       'Remota',
                tipo_contratacao: 'Freelancer',
                localizacao:      'Brasil / LATAM',
            }, 'workana'));
        }
    }

    console.error(`[workana] Total coletado: ${results.length}`);
    return results;
}
