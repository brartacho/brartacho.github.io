// Scraper do 99Freelas (99freelas.com.br) via fetch + Cheerio.
// Plataforma de freelance 100% brasileira.
// URL: https://www.99freelas.com.br/projects?q=KEYWORD
// Tipo de contratação: Freelancer

import { load } from 'cheerio';
import { normalize } from './normalizer.js';

const BASE_URL = 'https://www.99freelas.com.br';

const HEADERS = {
    'accept':          'text/html,application/xhtml+xml',
    'accept-language': 'pt-BR,pt;q=0.9',
    'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'referer':         'https://www.99freelas.com.br/',
};

async function fetchPage(url) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

function extractJobs($) {
    const results = [];

    // 99Freelas usa .result-list-item ou similar
    const selectors = [
        '.result-list-item, .project-item, [class*="result-item"]',
        'li[class*="project"], li[class*="result"]',
        'article[class*="project"]',
        '.item[class*="project"]',
    ];

    for (const sel of selectors) {
        const items = $(sel).filter((_, el) => $(el).find('a').length > 0);
        if (!items.length) continue;

        items.each((_, el) => {
            const $el    = $(el);
            const linkEl = $el.find('h2 a, h3 a, a.title, a[href*="/project/"], a[href*="/projeto/"]').first();
            const link   = linkEl.attr('href') || $el.find('a').first().attr('href');
            if (!link) return;

            const fullLink = link.startsWith('http') ? link : `${BASE_URL}${link}`;
            const title    = linkEl.text().trim() || $el.find('h2, h3, .title').first().text().trim();
            const desc     = $el.find('p, .description, [class*="desc"]').first().text().trim().slice(0, 300) || null;
            const budget   = $el.find('.budget, .price, [class*="valor"], [class*="budget"]').first().text().trim();
            const skills   = $el.find('.skills, .tags, [class*="skill"], [class*="tag"]')
                              .map((_, t) => $(t).text().trim()).get().filter(Boolean).join(', ');

            if (!title) return;
            results.push({ fullLink, title, desc, budget, skills });
        });

        if (results.length) break;
    }

    // Fallback: links para /project/ ou /projeto/
    if (!results.length) {
        $('a[href*="/project/"], a[href*="/projeto/"]').each((_, a) => {
            const href = $(a).attr('href') || '';
            if (!href) return;
            const fullLink = href.startsWith('http') ? href : `${BASE_URL}${href}`;
            const title    = $(a).text().trim();
            if (!title) return;
            results.push({ fullLink, title, desc: null, budget: null, skills: null });
        });
    }

    return results;
}

export async function searchFreelas99({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;
        console.error(`[99freelas] Buscando: "${keyword}"`);

        const url = `${BASE_URL}/projects?q=${encodeURIComponent(keyword)}`;
        let html;
        try {
            html = await fetchPage(url);
        } catch (e) {
            console.error(`[99freelas] Erro ao buscar "${keyword}": ${e.message}`);
            continue;
        }

        const $    = load(html);
        const jobs = extractJobs($);
        console.error(`[99freelas] Jobs para "${keyword}": ${jobs.length}`);

        for (const job of jobs) {
            if (results.length >= maxResults) break;
            if (!job.fullLink || seen.has(job.fullLink)) continue;
            seen.add(job.fullLink);

            results.push(normalize({
                empresa:          'Cliente 99Freelas',
                vaga:             job.title,
                link_vaga:        job.fullLink,
                descricao:        [job.desc, job.skills].filter(Boolean).join(' | ') || null,
                modalidade:       'Remota',
                tipo_contratacao: 'Freelancer',
                localizacao:      'Brasil',
            }, '99freelas'));
        }
    }

    console.error(`[99freelas] Total coletado: ${results.length}`);
    return results;
}
