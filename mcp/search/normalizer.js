// Formato canônico de lead descoberto pelos scrapers.
// Todas as plataformas convertem seus resultados para este shape antes de ingest.

// Regex de detecção: cobre masculino/feminino, com/sem acento (texto já passa por NFD+strip)
const RE_HIBRIDA    = /hibrid[oa]|hybrid|semi.?presencial|flexiv[ea]l/;
const RE_REMOTA     = /remot[oa]|remote|home.?office|homeoffice/;
const RE_PRESENCIAL = /presencial|on.?site|in.?person/;


function strip(text) {
    return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function inferModalidade(text) {
    if (!text) return null;
    const t = strip(text);

    // Híbrida é mais específica — checada primeiro
    if (RE_HIBRIDA.test(t)) return 'Híbrida';
    // Presencial + indicador remoto juntos = Híbrida
    if (RE_PRESENCIAL.test(t) && RE_REMOTA.test(t)) return 'Híbrida';
    if (RE_REMOTA.test(t))     return 'Remota';
    if (RE_PRESENCIAL.test(t)) return 'Presencial';
    return null;
}

function inferTipo(text) {
    if (!text) return null;
    const t = strip(text);
    if (t.includes('freelancer'))         return 'Freelancer';
    if (t.includes('cooperado'))          return 'Cooperado';
    if (/temporari[oa]/.test(t))          return 'Temporário';
    if (/estagio|estagiario/.test(t))     return 'Estágio';
    if (/autonomo|autonoma/.test(t))      return 'Autônomo';
    // PJ antes de CLT para evitar falso-positivo em "Benefícios: CLT para PJ"
    if (/pessoa\s+juridica|regime\s+pj|\bpj\b/.test(t)) return 'PJ';
    if (/\bclt\b/.test(t))                return 'CLT';
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
    // Prioridade: campo explícito > localização/tipo_local > descrição (evita falsos positivos)
    // Todos os campos passam por inferModalidade/inferTipo para normalizar casing e acentuação
    const modalidade =
        inferModalidade(`${raw.modalidade ?? ''} ${raw.localizacao ?? ''} ${raw.tipo_local ?? ''}`) ||
        inferModalidade(raw.descricao ?? '');

    const tipo_contratacao =
        inferTipo(`${raw.tipo_contratacao ?? ''} ${raw.contrato ?? ''} ${raw.regime ?? ''}`) ||
        inferTipo(raw.descricao ?? '');

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
