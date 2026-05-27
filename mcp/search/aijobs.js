// Scraper do The AI Job Board (theaijobboard.com) via fetch + Cheerio.
// Site WordPress com WP Job Manager. Server-side rendered, sem Playwright.
// Focado em vagas de IA/ML (internacional, inglês).

import { load } from 'cheerio';
import { normalize } from './normalizer.js';

const BASE_URL = 'https://theaijobboard.com';

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

function extractWpJobManagerJobs($) {
    const results = [];

    // WP Job Manager: lista ul.job_listings
    $('ul.job_listings li.job_listing, .job_listings .job_listing').each((_, el) => {
        const $el      = $(el);
        const linkEl   = $el.find('.job_listing-clickbox, h3 a, h2 a, a').first();
        const link     = linkEl.attr('href') || $el.find('a').first().attr('href');
        const title    = $el.find('.job_listing-title, h3, h2').first().text().trim();
        const company  = $el.find('.company strong, .company span, .company').first().text().trim();
        const location = $el.find('.location').first().text().trim();
        const type     = $el.find('.job-type').first().text().trim();

        if (link && title) results.push({ link, title, company, location, type });
    });

    if (results.length) return results;

    // Fallback genérico: artigos/posts WP
    $('article, .entry, .post, .job, .job-listing, [class*="job"]').each((_, el) => {
        const $el    = $(el);
        const titleEl = $el.find('h2 a, h1 a, .entry-title a, .job-title a, h3 a').first();
        const link   = titleEl.attr('href');
        const title  = titleEl.text().trim() || $el.find('h2, h3').first().text().trim();
        const company = $el.find('.company, .employer, .company-name, [class*="company"]').first().text().trim();
        const location = $el.find('.location, [class*="location"]').first().text().trim();

        if (link && title) results.push({ link, title, company, location, type: null });
    });

    return results;
}

export async function searchAiJobs({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;
        console.error(`[aijobs] Buscando: "${keyword}"`);

        // WP Job Manager usa /jobs/?search_keywords= ; busca geral WP usa /?s=
        const urls = [
            `${BASE_URL}/jobs/?search_keywords=${encodeURIComponent(keyword)}&per_page=20`,
            `${BASE_URL}/?s=${encodeURIComponent(keyword)}&post_type=job_listing`,
            `${BASE_URL}/?s=${encodeURIComponent(keyword)}`,
        ];

        let html = null;
        for (const url of urls) {
            try {
                html = await fetchPage(url);
                break;
            } catch (e) {
                console.error(`[aijobs] Erro ${url}: ${e.message}`);
            }
        }
        if (!html) continue;

        const $    = load(html);
        const jobs = extractWpJobManagerJobs($);
        console.error(`[aijobs] Jobs para "${keyword}": ${jobs.length}`);

        for (const job of jobs) {
            if (results.length >= maxResults) break;
            if (!job.link || seen.has(job.link)) continue;
            seen.add(job.link);

            results.push(normalize({
                empresa:          job.company || 'Empresa não informada',
                vaga:             job.title,
                link_vaga:        job.link,
                modalidade:       'Remota',
                localizacao:      job.location || 'Worldwide',
                tipo_contratacao: job.type || null,
            }, 'aijobs'));
        }
    }

    console.error(`[aijobs] Total coletado: ${results.length}`);
    return results;
}
