// Scraper do RemoteOK via API pública.
// Endpoint: https://remoteok.com/api?tags=TAG (opcional)
// Retorna array. Primeiro item é metadata "legal" (ignorar).
// Filtragem por keyword é client-side (API não suporta search por título).
// Sem autenticação. User-Agent realista obrigatório (bloqueia Node default UA).

import { normalize } from './normalizer.js';

const API_URL = 'https://remoteok.com/api';

const HEADERS = {
    'accept':     'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// Normaliza keyword para checagem case-insensitive
function matches(job, keyword) {
    const k = keyword.toLowerCase();
    const hay = `${job.position ?? ''} ${job.company ?? ''} ${(job.tags ?? []).join(' ')} ${job.description ?? ''}`.toLowerCase();
    return hay.includes(k);
}

export async function searchRemoteOK({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];

    console.error(`[remoteok] Buscando ${keywords.length} keyword(s)`);

    let json;
    try {
        const res = await fetch(API_URL, {
            headers: HEADERS,
            signal:  AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`RemoteOK HTTP ${res.status}`);
        json = await res.json();
    } catch (e) {
        console.error(`[remoteok] Erro ao buscar API: ${e.message}`);
        return [];
    }

    // RemoteOK retorna array. Primeiro item é metadata "legal", resto são jobs.
    const allJobs = Array.isArray(json) ? json.filter(j => j && j.id) : [];
    console.error(`[remoteok] Jobs totais na API: ${allJobs.length}`);

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;

        const matched = allJobs.filter(j => matches(j, keyword));
        console.error(`[remoteok] Match para "${keyword}": ${matched.length}`);

        for (const job of matched) {
            if (results.length >= maxResults) break;

            const link = job.url || (job.id ? `https://remoteok.com/remote-jobs/${job.id}` : null);
            if (!link || seen.has(link)) continue;
            seen.add(link);

            const tags = Array.isArray(job.tags) ? job.tags.join(', ') : '';
            results.push(normalize({
                empresa:     job.company || 'Empresa não informada',
                vaga:        job.position || null,
                link_vaga:   link,
                descricao:   job.description || tags || null,
                modalidade:  'Remota',
                localizacao: job.location || null,
            }, 'remoteok'));
        }
    }

    console.error(`[remoteok] Total coletado: ${results.length}`);
    return results;
}
