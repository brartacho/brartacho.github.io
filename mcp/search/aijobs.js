// Scraper do aijobs.net via fetch + Cheerio.
// (Migrado de theaijobboard.com, que ficou atrás de Cloudflare 403.)
// Site server-rendered focado em vagas de IA/ML (internacional, inglês).
//
// URL: https://aijobs.net/?kw=KEYWORD
// O parâmetro kw é aceito pelo servidor, mas o filtro real é feito client-side
// (a página entrega ~50 vagas em todo carregamento). Filtramos por palavra-chave
// no título depois de extrair.

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

        // O text-end traz: nível, empresa, localização, modo, postado-em
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
    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;
        console.error(`[aijobs] Buscando: "${keyword}"`);

        let html;
        try {
            html = await fetchPage(`${BASE_URL}/?kw=${encodeURIComponent(keyword)}`);
        } catch (e) {
            console.error(`[aijobs] Erro ao buscar "${keyword}": ${e.message}`);
            continue;
        }

        const $    = load(html);
        const jobs = extractJobs($);
        console.error(`[aijobs] Jobs no HTML para "${keyword}": ${jobs.length}`);

        // Filtragem client-side: aijobs.net entrega todas as vagas em qualquer kw
        const kw = keyword.toLowerCase();
        let matched = 0;
        for (const job of jobs) {
            if (results.length >= maxResults) break;
            if (!job.link || seen.has(job.link)) continue;
            const hay = `${job.title} ${job.right ?? ''} ${job.tags ?? ''}`.toLowerCase();
            if (!hay.includes(kw)) continue;
            seen.add(job.link);
            matched++;

            results.push(normalize({
                empresa:     job.company || 'Empresa não informada',
                vaga:        job.title,
                link_vaga:   job.link,
                descricao:   job.tags || null,
                modalidade:  'Remota',
                localizacao: 'Worldwide',
            }, 'aijobs'));
        }
        console.error(`[aijobs] Após filtro "${keyword}": ${matched}`);
    }

    console.error(`[aijobs] Total coletado: ${results.length}`);
    return results;
}
