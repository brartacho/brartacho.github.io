// Scraper do Remotive via API pública.
// Endpoint: https://remotive.com/api/remote-jobs?search=KEYWORD&limit=20
// Sem autenticação. Sem rate-limit oficial documentado — usar timeout curto.
// 100% remote-only (internacional, predominantemente inglês).

import { normalize } from './normalizer.js';

const API_URL = 'https://remotive.com/api/remote-jobs';

const HEADERS = {
    'accept':     'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export async function searchRemotive({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;

        console.error(`[remotive] Buscando: "${keyword}"`);

        const params = new URLSearchParams({
            search: keyword,
            limit:  String(Math.min(maxResults - results.length, 20)),
        });

        let json;
        try {
            const res = await fetch(`${API_URL}?${params}`, {
                headers: HEADERS,
                signal:  AbortSignal.timeout(20_000),
            });
            if (!res.ok) throw new Error(`Remotive HTTP ${res.status}`);
            json = await res.json();
        } catch (e) {
            console.error(`[remotive] Erro ao buscar "${keyword}": ${e.message}`);
            continue;
        }

        const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
        console.error(`[remotive] Jobs para "${keyword}": ${jobs.length}`);

        for (const job of jobs) {
            if (results.length >= maxResults) break;

            const link = job.url || null;
            if (!link || seen.has(link)) continue;
            seen.add(link);

            results.push(normalize({
                empresa:          job.company_name || 'Empresa não informada',
                vaga:             job.title || null,
                link_vaga:        link,
                descricao:        job.description || null,
                modalidade:       'Remota',
                localizacao:      job.candidate_required_location || null,
                tipo_contratacao: job.job_type || null,
            }, 'remotive'));
        }
    }

    console.error(`[remotive] Total coletado: ${results.length}`);
    return results;
}
