// Scraper do Gupy via API pública.
// Endpoint: https://employability-portal.gupy.io/api/v1/jobs?term=KEYWORD&limit=20&offset=0
// Parâmetro correto é "term", não "searchTerm" (que retorna 400).

import { normalize } from './normalizer.js';

const API_URL = 'https://employability-portal.gupy.io/api/v1/jobs';

const HEADERS = {
    'accept':          'application/json',
    'accept-language': 'pt-BR,pt;q=0.9',
    'origin':          'https://portal.gupy.io',
    'referer':         'https://portal.gupy.io/',
    'sec-fetch-site':  'same-site',
    'sec-fetch-mode':  'cors',
    'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function mapWorkplace(wp, isRemote) {
    if (isRemote) return 'Remota';
    if (!wp) return null;
    const v = String(wp).toLowerCase();
    if (v === 'remote')                    return 'Remota';
    if (v === 'hybrid')                    return 'Híbrida';
    if (v === 'on-site' || v === 'onsite') return 'Presencial';
    return null;
}

export async function searchGupy({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;

        console.error(`[gupy] Buscando: "${keyword}"`);

        const params = new URLSearchParams({
            term:   keyword,
            limit:  String(Math.min(maxResults - results.length, 20)),
            offset: '0',
        });

        let json;
        try {
            const res = await fetch(`${API_URL}?${params}`, {
                headers: HEADERS,
                signal:  AbortSignal.timeout(20_000),
            });
            if (!res.ok) throw new Error(`Gupy HTTP ${res.status}`);
            json = await res.json();
        } catch (e) {
            console.error(`[gupy] Erro ao buscar "${keyword}": ${e.message}`);
            continue;
        }

        const jobs = Array.isArray(json?.data) ? json.data : [];
        console.error(`[gupy] Jobs para "${keyword}": ${jobs.length}`);

        for (const job of jobs) {
            if (results.length >= maxResults) break;

            const link = job.jobUrl || null;
            if (!link || seen.has(link)) continue;
            seen.add(link);

            const locParts = [job.city, job.state].filter(Boolean);
            results.push(normalize({
                empresa:         job.careerPageName || 'Empresa não informada',
                vaga:            job.name || null,
                link_vaga:       link,
                descricao:       job.description || null,
                modalidade:      mapWorkplace(job.workplaceType, job.isRemoteWork),
                localizacao:     locParts.length ? locParts.join(' - ') : null,
            }, 'gupy'));
        }
    }

    console.error(`[gupy] Total coletado: ${results.length}`);
    return results;
}
