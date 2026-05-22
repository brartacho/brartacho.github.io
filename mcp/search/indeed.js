// Scraper do Indeed Brasil via RSS feed público.
// URL: https://br.indeed.com/rss?q=KEYWORD&l=Brasil&sort=date
// Não requer autenticação. RSS retorna até 20 itens por query.

import { normalize } from './normalizer.js';

function buildRssUrl(keyword) {
    const params = new URLSearchParams({
        q:      keyword,
        l:      'Brasil',
        sort:   'date',
        radius: '50',
        limit:  '20',
    });
    return `https://br.indeed.com/rss?${params.toString()}`;
}

function stripHtml(html) {
    return (html || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// Parser RSS manual — evita dependência de biblioteca XML
function parseRssItems(xml) {
    const items = [];
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

    for (const [, body] of itemMatches) {
        const get = (tag) => {
            const m = body.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 's'));
            return m ? m[1].trim() : null;
        };

        const title       = get('title');
        const link        = get('link') || get('guid');
        const description = get('description');
        const pubDate     = get('pubDate');

        if (!link) continue;

        // Indeed coloca "Título - Empresa" no campo title
        let vaga    = title;
        let empresa = null;
        if (title?.includes(' - ')) {
            const parts = title.split(' - ');
            vaga    = parts.slice(0, -1).join(' - ').trim();
            empresa = parts[parts.length - 1].trim();
        }

        // Limpa a URL de tracking do Indeed
        let linkClean = link;
        try {
            const u = new URL(link);
            // Indeed usa: https://br.indeed.com/viewjob?jk=JOBKEY
            // Ou redirect: https://br.indeed.com/pagead/clk?...
            const jk = u.searchParams.get('jk');
            if (jk) linkClean = `https://br.indeed.com/viewjob?jk=${jk}`;
        } catch { /* usa link original */ }

        items.push({ vaga, empresa, link: linkClean, description, pubDate });
    }

    return items;
}

export async function searchIndeed({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;

        console.error(`[indeed] Buscando: "${keyword}"`);
        const url = buildRssUrl(keyword);

        let xml;
        try {
            const res = await fetch(url, {
                headers: {
                    'Accept':          'application/rss+xml,application/xml,text/xml',
                    'Accept-Language': 'pt-BR,pt;q=0.9',
                    'User-Agent':      'Mozilla/5.0 (compatible; job-radar/1.0)',
                },
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) throw new Error(`Indeed HTTP ${res.status}`);
            xml = await res.text();
        } catch (e) {
            console.error(`[indeed] Erro: ${e.message}`);
            continue;
        }

        const items = parseRssItems(xml);
        console.error(`[indeed] Items RSS para "${keyword}": ${items.length}`);

        for (const item of items) {
            if (results.length >= maxResults) break;
            if (!item.link || seen.has(item.link)) continue;
            seen.add(item.link);

            results.push(normalize({
                empresa:    item.empresa || 'Empresa não informada',
                vaga:       item.vaga,
                link_vaga:  item.link,
                descricao:  stripHtml(item.description),
                localizacao: 'Brasil',
            }, 'indeed'));
        }
    }

    console.error(`[indeed] Total coletado: ${results.length}`);
    return results;
}
