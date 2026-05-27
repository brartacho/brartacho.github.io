// Scraper do We Work Remotely via feeds RSS públicos.
// Endpoints por categoria: https://weworkremotely.com/categories/<categoria>.rss
// Sem autenticação. Parsing XML via regex (formato estável, sem deps).
// Filtragem por keyword é client-side sobre title + description.

import { normalize } from './normalizer.js';

// Categorias RSS suportadas. O título da plataforma agrega as 5 mais relevantes.
const CATEGORIES = [
    'remote-programming-jobs',
    'remote-devops-sysadmin-jobs',
    'remote-customer-support-jobs',
    'remote-design-jobs',
    'all-other-remote-jobs',
];

const HEADERS = {
    'accept':     'application/rss+xml, application/xml, text/xml',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// Extrai um campo de dentro de um bloco <item>...</item>
function extractField(itemXml, tag) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = itemXml.match(re);
    if (!m) return null;
    return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .trim() || null;
}

// O title vem como "Company Name: Position". Separa em empresa + vaga.
function splitTitle(title) {
    if (!title) return { empresa: null, vaga: null };
    const idx = title.indexOf(':');
    if (idx === -1) return { empresa: null, vaga: title.trim() };
    return {
        empresa: title.slice(0, idx).trim() || null,
        vaga:    title.slice(idx + 1).trim() || null,
    };
}

function matches(text, keyword) {
    return text.toLowerCase().includes(keyword.toLowerCase());
}

async function fetchCategoryItems(category) {
    const url = `https://weworkremotely.com/categories/${category}.rss`;
    try {
        const res = await fetch(url, {
            headers: HEADERS,
            signal:  AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`WWR HTTP ${res.status}`);
        const xml = await res.text();
        // Captura todos os <item>...</item>
        return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    } catch (e) {
        console.error(`[wwr] Erro ao buscar categoria "${category}": ${e.message}`);
        return [];
    }
}

export async function searchWeWorkRemotely({ keywords, maxResults = 20, categories } = {}) {
    const seen    = new Set();
    const results = [];
    const cats    = (Array.isArray(categories) && categories.length) ? categories : CATEGORIES;

    console.error(`[wwr] Buscando em ${cats.length} categorias`);

    for (const category of cats) {
        if (results.length >= maxResults) break;

        const items = await fetchCategoryItems(category);
        console.error(`[wwr] Categoria "${category}": ${items.length} itens`);

        for (const itemXml of items) {
            if (results.length >= maxResults) break;

            const link = extractField(itemXml, 'link');
            if (!link || seen.has(link)) continue;

            const title       = extractField(itemXml, 'title');
            const region      = extractField(itemXml, 'region');
            const description = extractField(itemXml, 'description');

            // Filtra por pelo menos uma keyword (case-insensitive sobre title + description)
            const hay = `${title ?? ''} ${description ?? ''}`;
            const matchAny = keywords.some(k => matches(hay, k));
            if (!matchAny) continue;

            seen.add(link);
            const { empresa, vaga } = splitTitle(title);

            results.push(normalize({
                empresa:     empresa || 'Empresa não informada',
                vaga,
                link_vaga:   link,
                descricao:   description,
                modalidade:  'Remota',
                localizacao: region,
            }, 'weworkremotely'));
        }
    }

    console.error(`[wwr] Total coletado: ${results.length}`);
    return results;
}
