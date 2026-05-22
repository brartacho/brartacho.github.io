// Scraper de empregos.maringa.com — área TI (categoria 18).
// Faz fetch do HTML de listagem e depois das páginas individuais.
// Não requer autenticação.

import { parse } from 'node-html-parser';
import { normalize } from './normalizer.js';

const BASE_URL = 'https://empregos.maringa.com';

function buildUrl(keyword) {
    const params = new URLSearchParams({
        text:           keyword,
        area:           '18',
        ordem:          'publicacao',
        estado:         '',
        cidade:         '',
        experiencia:    '',
        faixa_salarial: '',
    });
    return `${BASE_URL}/?${params.toString()}`;
}

async function fetchHtml(url) {
    const res = await fetch(url, {
        headers: {
            'Accept':          'text/html,application/xhtml+xml',
            'Accept-Language': 'pt-BR,pt;q=0.9',
            'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Maringá HTTP ${res.status}`);
    return res.text();
}

function extractListings(html) {
    const root = parse(html);
    const listings = [];

    // Tenta múltiplos seletores (o site pode mudar estrutura)
    const cards = root.querySelectorAll([
        '.vaga-item',
        '.job-item',
        'article.vaga',
        '.listagem-vagas .item',
        '.resultado-vagas .vaga',
        'li.vaga',
    ].join(','));

    for (const card of cards) {
        const titleEl = card.querySelector('h2, h3, .titulo-vaga, .job-title, a[href*="/vaga/"]');
        const companyEl = card.querySelector('.empresa, .company, .nome-empresa');
        const linkEl = card.querySelector('a[href*="/vaga/"]') || card.querySelector('a');

        const href = linkEl?.getAttribute('href') || '';
        const link = href.startsWith('http') ? href : href ? `${BASE_URL}${href}` : null;

        if (!link) continue;

        listings.push({
            vaga:    titleEl?.text?.trim() || null,
            empresa: companyEl?.text?.trim() || null,
            link,
        });
    }

    // Fallback: tenta extrair todos os links que parecem vagas
    if (listings.length === 0) {
        const links = root.querySelectorAll('a[href*="/vaga/"]');
        const seen = new Set();
        for (const a of links) {
            const href = a.getAttribute('href') || '';
            const link = href.startsWith('http') ? href : `${BASE_URL}${href}`;
            if (seen.has(link)) continue;
            seen.add(link);
            listings.push({
                vaga:    a.text?.trim() || null,
                empresa: null,
                link,
            });
        }
    }

    return listings;
}

async function fetchJobDetail(url) {
    try {
        const html  = await fetchHtml(url);
        const root  = parse(html);
        const descEl = root.querySelector([
            '.descricao-vaga',
            '.job-description',
            '.conteudo-vaga',
            '#descricao',
            '.vaga-descricao',
            'section.descricao',
        ].join(','));

        const empresa = root.querySelector('.empresa-nome, .company-name, h2.empresa')?.text?.trim() || null;
        const tipo    = root.querySelector('.regime, .contrato, .tipo-contrato')?.text?.trim() || null;

        return {
            descricao: descEl?.text?.trim() || null,
            empresa,
            tipo_contratacao: tipo,
        };
    } catch {
        return { descricao: null, empresa: null, tipo_contratacao: null };
    }
}

export async function searchMaringa({ keywords, maxResults = 15 }) {
    const seen    = new Set();
    const results = [];

    for (const keyword of keywords) {
        if (results.length >= maxResults) break;

        console.error(`[maringa] Buscando: "${keyword}"`);

        let html;
        try {
            html = await fetchHtml(buildUrl(keyword));
        } catch (e) {
            console.error(`[maringa] Erro na listagem: ${e.message}`);
            continue;
        }

        const listings = extractListings(html);
        console.error(`[maringa] Cards encontrados para "${keyword}": ${listings.length}`);

        for (const item of listings) {
            if (results.length >= maxResults) break;
            if (!item.link || seen.has(item.link)) continue;
            seen.add(item.link);

            const detail = await fetchJobDetail(item.link);

            results.push(normalize({
                empresa:         detail.empresa || item.empresa || 'Empresa não informada',
                vaga:            item.vaga,
                link_vaga:       item.link,
                descricao:       detail.descricao,
                tipo_contratacao: detail.tipo_contratacao,
                localizacao:     'Maringá - PR',
            }, 'maringa'));

            // Delay cortês entre páginas de detalhe
            await new Promise((r) => setTimeout(r, 600 + Math.random() * 800));
        }
    }

    console.error(`[maringa] Total coletado: ${results.length}`);
    return results;
}
