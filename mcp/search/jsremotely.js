// Scraper do JS Remotely (jsremotely.com) via fetch + Cheerio.
// Site server-rendered focado em vagas JavaScript remote (internacional).
// URL: https://jsremotely.com/?keywords=KEYWORD
//
// Cards reais: .jobcardStyle1 (20 por página). O título não está em h1-h4,
// está em <div class="tw-text-lg tw-font-medium">. Links externos apontam
// para https://javascript.jobs/job/<slug>.
// jsremotely respeita o parâmetro ?keywords= server-side, mas para garantir
// também fazemos um filtro client-side leve (case-insensitive).

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
    const out  = [];
    const seen = new Set();

    $('.jobcardStyle1').each((_, el) => {
        const $card = $(el);

        // Link: âncora interna OU âncora dentro do card para /job/
        let link =
            $card.find('a[href*="javascript.jobs/job/"]').first().attr('href') ||
            $card.find('a[href*="/job/"]').first().attr('href');
        if (!link) {
            // Pode estar como ancestral (card envolto pelo <a>)
            const wrap = $card.closest('a[href]').attr('href');
            if (wrap) link = wrap;
        }
        if (!link) return;

        const full = link.startsWith('http') ? link : `${BASE_URL}${link}`;
        if (seen.has(full)) return;

        // Título: primeiro div com font-medium e texto não-vazio.
        // Fallback: primeiro div com >= 6 chars que não seja apenas tag/idade.
        let title = $card.find('.tw-font-medium').first().text().replace(/\s+/g, ' ').trim();
        if (!title) {
            $card.find('div').each((_, d) => {
                const t = $(d).text().replace(/\s+/g, ' ').trim();
                if (!title && t.length > 6 && !/^(Full Time|Remote|\d+\w+)$/i.test(t)) title = t;
            });
        }
        if (!title) return;

        const tags = $card.find('span').map((_, s) => $(s).text().trim()).get()
                          .filter(t => t && t.length < 30).slice(0, 6).join(', ');

        seen.add(full);
        out.push({ link: full, title, tags });
    });

    // Fallback: se nenhum card foi identificado por classe, varre links diretos
    if (!out.length) {
        $('a[href*="javascript.jobs/job/"], a[href*="/job/"]').each((_, a) => {
            const $a   = $(a);
            const href = $a.attr('href') || '';
            if (!href) return;
            const full = href.startsWith('http') ? href : `${BASE_URL}${href}`;
            if (seen.has(full)) return;
            const title = $a.text().replace(/\s+/g, ' ').trim();
            if (!title || title.length < 4) return;
            seen.add(full);
            out.push({ link: full, title, tags: '' });
        });
    }

    return out;
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
            if (!job.link || seen.has(job.link)) continue;

            // Filtro leve: se o servidor já filtrou, todos batem; se voltou catálogo
            // completo (ex: fallback sem keyword), corta pelos que mencionam.
            const hay = `${job.title} ${job.tags ?? ''}`.toLowerCase();
            if (!hay.includes(kw)) continue;

            seen.add(job.link);
            results.push(normalize({
                empresa:    'Empresa não informada',
                vaga:       job.title,
                link_vaga:  job.link,
                descricao:  job.tags || null,
                modalidade: 'Remota',
            }, 'jsremotely'));
        }
    }

    console.error(`[jsremotely] Total coletado: ${results.length}`);
    return results;
}
