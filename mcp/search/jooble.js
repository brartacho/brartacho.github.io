// Scraper do Jooble via API pública (chave gratuita).
// Endpoint: POST https://jooble.org/api/<JOOBLE_API_KEY>
// Body: { keywords: "KEYWORD", location: "Brasil", page: 1 }
// Retorna JSON com array de vagas.
//
// Para obter a chave: https://jooble.org/api/about (cadastro gratuito)
// Adicionar JOOBLE_API_KEY ao .env.local (MCP_ENV no .mcp.json)
//
// Se JOOBLE_API_KEY não estiver definida, o scraper retorna [] com aviso.

import { normalize } from './normalizer.js';

const JOOBLE_API = 'https://jooble.org/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export async function searchJooble({ keywords, location = 'Brasil', maxResults = 20 }) {
    const apiKey = process.env.JOOBLE_API_KEY;
    if (!apiKey) {
        throw new Error('JOOBLE_API_KEY não configurada. Registre em https://jooble.org/api/about e adicione ao .env.local');
    }

    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;
        console.error(`[jooble] Buscando: "${keyword}" em "${location}"`);

        let json;
        try {
            const res = await fetch(`${JOOBLE_API}/${apiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'user-agent':   UA,
                },
                body: JSON.stringify({
                    keywords: keyword,
                    location,
                    page: 1,
                    resultsOnPage: Math.min(maxResults - results.length, 20),
                }),
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) throw new Error(`Jooble HTTP ${res.status}`);
            json = await res.json();
        } catch (e) {
            console.error(`[jooble] Erro ao buscar "${keyword}": ${e.message}`);
            continue;
        }

        const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
        console.error(`[jooble] Jobs para "${keyword}": ${jobs.length}`);

        for (const job of jobs) {
            if (results.length >= maxResults) break;

            const link = job.link || null;
            if (!link || seen.has(link)) continue;
            seen.add(link);

            results.push(normalize({
                empresa:          job.company   || 'Empresa não informada',
                vaga:             job.title     || null,
                link_vaga:        link,
                descricao:        job.snippet   || null,
                localizacao:      job.location  || location,
                tipo_contratacao: job.type      || null,
                nivel:            job.level     || null,
            }, 'jooble'));
        }
    }

    console.error(`[jooble] Total coletado: ${results.length}`);
    return results;
}
