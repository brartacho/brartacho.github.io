// Formato canônico de lead descoberto pelos scrapers.
// Todas as plataformas convertem seus resultados para este shape antes de ingest.

const MODALIDADE_MAP = {
    remoto: 'Remota', remote: 'Remota', 'home office': 'Remota', homeoffice: 'Remota',
    hibrido: 'Híbrida', híbrido: 'Híbrida', hybrid: 'Híbrida',
    presencial: 'Presencial', 'on-site': 'Presencial', onsite: 'Presencial',
};

const TIPO_MAP = {
    clt: 'CLT', pj: 'PJ', 'pessoa juridica': 'PJ', 'pessoa jurídica': 'PJ',
    freelancer: 'Freelancer', cooperado: 'Cooperado', temporario: 'Temporário',
    temporário: 'Temporário', estagio: 'Estágio', estágio: 'Estágio', autonomo: 'Autônomo',
    autônomo: 'Autônomo',
};

function inferModalidade(text) {
    if (!text) return null;
    const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const [key, val] of Object.entries(MODALIDADE_MAP)) {
        if (t.includes(key)) return val;
    }
    return null;
}

function inferTipo(text) {
    if (!text) return null;
    const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const [key, val] of Object.entries(TIPO_MAP)) {
        if (t.includes(key)) return val;
    }
    return null;
}

function cleanText(html) {
    if (!html) return null;
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s{2,}/g, ' ')
        .trim() || null;
}

export function normalize(raw, fonte) {
    const modalidade = raw.modalidade
        ? (MODALIDADE_MAP[raw.modalidade.toLowerCase()] ?? raw.modalidade)
        : inferModalidade(`${raw.localizacao ?? ''} ${raw.tipo_local ?? ''} ${raw.descricao ?? ''}`);

    const tipo_contratacao = raw.tipo_contratacao
        ? (TIPO_MAP[raw.tipo_contratacao.toLowerCase()] ?? null)
        : inferTipo(`${raw.contrato ?? ''} ${raw.regime ?? ''} ${raw.descricao ?? ''}`);

    return {
        empresa:          String(raw.empresa ?? '').trim() || 'Empresa não informada',
        vaga:             raw.vaga ? String(raw.vaga).trim() : null,
        link_vaga:        String(raw.link_vaga ?? '').trim(),
        descricao:        cleanText(raw.descricao) ?? null,
        fonte,
        modalidade:       modalidade ?? null,
        tipo_contratacao: tipo_contratacao ?? null,
        nivel:            raw.nivel ? String(raw.nivel).trim() : null,
        localizacao:      raw.localizacao ? String(raw.localizacao).trim() : null,
    };
}
