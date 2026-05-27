// Scraper do aijobs.net via fetch + Cheerio.
// Site server-rendered focado em vagas de IA/ML (internacional, inglês).
//
// URL: https://aijobs.net/
// A página entrega ~50 vagas independente do parâmetro kw (filtro é client-side).
// Retornamos todas as vagas e deixamos o motor de scoring decidir a relevância.

import { load } from 'cheerio';
import { normalize } from './normalizer.js';

const BASE_URL = 'https://aijobs.net';

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
    const out = [];
    $('a.stretched-link[href^="/job/"]').each((_, a) => {
        const $a   = $(a);
        const href = $a.attr('href') || '';
        if (!href) return;

        const full = href.startsWith('http') ? href : `${BASE_URL}${href}`;

        // Título: texto do <a> excluindo as labels "Featured"/"Feat."
        $a.find('.text-bg-primary').remove();
        const title = $a.text().replace(/\s+/g, ' ').trim();
        if (!title) return;

        const $card = $a.closest('li');
        const tags  = $card.find('.text-end span').map((_, s) => $(s).text().trim()).get();
        const right = $card.find('.text-end').text().replace(/\s+/g, ' ').trim();

        out.push({
            link:    full,
            title,
            company: right.split('|')[1]?.trim() || null,
            tags:    tags.join(', '),
            right,
        });
    });
    return out;
}

export async function searchAiJobs({ keywords, maxResults = 20 }) {
    console.error(`[aijobs] Buscando até ${maxResults} vagas`);

    let html;
    try {
        // kw param não filtra server-side — fetch único retorna todas as vagas
        html = await fetchPage(`${BASE_URL}/`);
    } catch (e) {
        console.error(`[aijobs] Erro ao buscar: ${e.message}`);
        return [];
    }

    const $    = load(html);
    const jobs = extractJobs($);
    console.error(`[aijobs] Jobs no HTML: ${jobs.length}`);

    const seen    = new Set();
    const results = [];

    for (const job of jobs) {
        if (results.length >= maxResults) break;
        if (!job.link || seen.has(job.link)) continue;
        seen.add(job.link);

        results.push(normalize({
            empresa:     job.company || 'Empresa não informada',
            vaga:        job.title,
            link_vaga:   job.link,
            descricao:   job.tags || null,
            modalidade:  'Remota',
            localizacao: 'Worldwide',
        }, 'aijobs'));
    }

    console.error(`[aijobs] Total coletado: ${results.length}`);
    return results;
}
