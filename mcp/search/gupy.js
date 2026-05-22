// Scraper do Gupy via API semi-pública.
// Endpoint: https://portal.gupy.io/api/job-posting/jobs
// Retorna JSON paginado sem autenticação.

import { normalize } from './normalizer.js';

const BASE_URL = 'https://portal.gupy.io/api/job-posting/jobs';
const JOB_URL  = 'https://portal.gupy.io/api/job-posting/jobs';

function buildUrl(keyword, offset = 0, limit = 20) {
    const params = new URLSearchParams({
        jobName:    keyword,
        limit:      String(limit),
        offset:     String(offset),
        workplaceType: '',     // todos (presencial, remoto, híbrido)
    });
    return `${BASE_URL}?${params.toString()}`;
}

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: {
            'Accept':          'application/json',
            'Accept-Language': 'pt-BR,pt;q=0.9',
            'User-Agent':      'Mozilla/5.0 (compatible; job-radar/1.0)',
        },
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Gupy HTTP ${res.status} para ${url}`);
    return res.json();
}

function mapWorkplace(wp) {
    if (!wp) return null;
    const v = String(wp).toLowerCase();
    if (v === 'remote') return 'Remota';
    if (v === 'hybrid') return 'Híbrida';
    if (v === 'on-site' || v === 'onsite') return 'Presencial';
    return null;
}

export async function searchGupy({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;

        console.error(`[gupy] Buscando: "${keyword}"`);
        const url = buildUrl(keyword, 0, Math.min(maxResults - results.length, 20));

        let json;
        try {
            json = await fetchJson(url);
        } catch (e) {
            console.error(`[gupy] Erro ao buscar "${keyword}": ${e.message}`);
            continue;
        }

        const jobs = Array.isArray(json?.data) ? json.data
                   : Array.isArray(json?.jobs)  ? json.jobs
                   : Array.isArray(json)         ? json
                   : [];

        for (const job of jobs) {
            if (results.length >= maxResults) break;

            const jobId    = job.id || job.jobId;
            const jobSlug  = job.jobUrl || job.applicationUrl || job.slug;
            const link     = jobSlug
                ? (jobSlug.startsWith('http') ? jobSlug : `https://portal.gupy.io/job-offer/${jobId}`)
                : null;

            if (!link || seen.has(link)) continue;
            seen.add(link);

            results.push(normalize({
                empresa:         job.companyName || job.company?.name || 'Empresa não informada',
                vaga:            job.name || job.title || null,
                link_vaga:       link,
                descricao:       job.description || job.jobDescription || null,
                modalidade:      mapWorkplace(job.workplaceType || job.workplace),
                tipo_contratacao: job.contractType || job.contractTypeName || null,
                nivel:           job.experienceLevel || job.seniority || null,
                localizacao:     job.city ? `${job.city}${job.state ? ` - ${job.state}` : ''}` : null,
            }, 'gupy'));
        }
    }

    console.error(`[gupy] Total coletado: ${results.length}`);
    return results;
}
