// ============================================================
// Radar de Vagas — motor de pontuação por regras (0–10)
// ============================================================
// Função pura, sem dependências e sem I/O — pode rodar no serverless
// (radar.js) e ser espelhada no front para feedback instantâneo.
//
// Pesos (método do usuário): skills 4 · nível 2 · setor 2 · modalidade 1 ·
// contratação 1 = 10. skills_evolucao conta como POSITIVO (diferencial),
// nunca penaliza. Sênior "fechado" vs nível-alvo Pleno penaliza.
// ============================================================

const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
const norm = (s) =>
    String(s ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(DIACRITICS, ''); // remove acentos (diacríticos combinantes)

const arr = (v) => (Array.isArray(v) ? v : []);

// Conta quantos termos da lista aparecem no texto; devolve os que casaram.
function matchTerms(haystack, terms) {
    const hits = [];
    for (const t of terms) {
        const term = norm(t).trim();
        if (term && haystack.includes(term)) hits.push(t);
    }
    return hits;
}

// Inferência simples de senioridade a partir do título/descrição.
function inferSeniority(text) {
    if (/\b(senior|sr|especialista|staff|lead)\b/.test(text)) return 'senior';
    if (/\b(junior|jr)\b/.test(text)) return 'junior';
    if (/\b(pleno|pl|mid)\b/.test(text)) return 'pleno';
    if (/\b(estagi|trainee)\b/.test(text)) return 'intern';
    return 'unknown';
}

/**
 * @param {object} vaga    { vaga, descricao, nivel, modalidade, tipo_contratacao, requires_cnh: string|null }
 * @param {object} profile { nivel_alvo, skills_core[], skills_evolucao[], gaps[],
 *                           setores[], keywords[], modalidade_pref, contratacao_pref,
 *                           contratacao_prefs[], cnh }
 * @returns {{ score:number, keywords_match:string[], gaps_preliminares:string[],
 *            breakdown:object, seniority_inferred:string }}
 */
export function scoreVaga(vaga = {}, profile = {}) {
    const haystack = norm(`${vaga.vaga || ''} ${vaga.descricao || ''} ${vaga.nivel || ''}`);

    // ---- Skills (até 4 pts) ----
    const core = arr(profile.skills_core);
    const evol = arr(profile.skills_evolucao);
    const keys = arr(profile.keywords);
    const coreHits = matchTerms(haystack, core);
    const evolHits = matchTerms(haystack, evol);
    const keyHits = matchTerms(haystack, keys);
    // dedup do conjunto exibido
    const keywords_match = [...new Set([...coreHits, ...keyHits, ...evolHits])];
    // proporção sobre as skills core (base) + bônus por diferenciais em evolução
    const coreRatio = core.length ? coreHits.length / core.length : 0;
    const evolBonus = Math.min(0.25 * evolHits.length, 1); // diferenciais somam, sem penalizar
    const skillsPts = Math.min(4, coreRatio * 3 + evolBonus);

    // ---- Nível (até 2 pts) ----
    const alvo = norm(profile.nivel_alvo || 'pleno');
    const sen = inferSeniority(haystack);
    let nivelPts;
    if (sen === 'unknown') nivelPts = 1.4;            // requisito vago favorece perfil sólido
    else if (sen === alvo) nivelPts = 2;
    else if (alvo === 'pleno' && sen === 'junior') nivelPts = 1.5; // aceitável (subvaloriza)
    else if (alvo === 'pleno' && sen === 'senior') nivelPts = 0.5; // sênior fechado penaliza
    else if (sen === 'intern') nivelPts = 0.3;
    else nivelPts = 1;

    // ---- Setor (até 2 pts) ----
    const setorHits = matchTerms(haystack, arr(profile.setores));
    const setorPts = Math.min(2, setorHits.length * 1); // cada setor citado vale 1, teto 2

    // ---- Modalidade (até 1 pt) ----
    const modVaga = vaga.modalidade || '';
    let modPts;
    if (!modVaga) modPts = 0.7;
    else if (modVaga === 'Remota') modPts = 1;
    else if (profile.modalidade_pref && modVaga === profile.modalidade_pref) modPts = 1;
    else if (modVaga === 'Híbrida') modPts = 0.7;
    else modPts = 0.3; // presencial fora da preferência

    // ---- Contratação (até 1 pt) ----
    const tipoVaga = vaga.tipo_contratacao || '';
    let contratPts;
    if (!tipoVaga) {
        contratPts = 0.6;
    } else {
        const prefs = arr(profile.contratacao_prefs);
        if (prefs.length > 0) {
            // novo: contratacao_prefs é array
            contratPts = prefs.includes(tipoVaga) ? 1 : 0.5;
        } else if (profile.contratacao_pref) {
            // retrocompatibilidade: contratacao_pref string
            contratPts = tipoVaga === profile.contratacao_pref ? 1 : 0.5;
        } else {
            contratPts = 0.5;
        }
    }

    // ---- CNH (penalidade até -0.5 pts) ----
    const requiresCnh = vaga.requires_cnh ?? null;
    const cnh = profile.cnh ?? { has: false, categories: [] };
    let cnhPts = 0;
    if (requiresCnh !== null) {
        if (!cnh.has) {
            cnhPts = -0.5; // exige CNH, candidato não tem
        } else if (requiresCnh !== 'qualquer' && !arr(cnh.categories).includes(requiresCnh)) {
            cnhPts = -0.3; // tem CNH mas categoria errada
        }
        // cnh.has=true e categoria compatível, ou requires_cnh='qualquer' → sem penalidade
    }

    const total = skillsPts + nivelPts + setorPts + modPts + contratPts + cnhPts;
    const score = Math.max(0, Math.min(10, Math.round(total)));

    // ---- Gaps preliminares: requisitos da vaga que são gaps do candidato ----
    const gaps_preliminares = matchTerms(haystack, arr(profile.gaps));

    return {
        score,
        seniority_inferred: sen,
        keywords_match,
        gaps_preliminares,
        breakdown: {
            skills: Number(skillsPts.toFixed(2)),
            nivel: Number(nivelPts.toFixed(2)),
            setor: Number(setorPts.toFixed(2)),
            modalidade: Number(modPts.toFixed(2)),
            contratacao: Number(contratPts.toFixed(2)),
            cnh: Number(cnhPts.toFixed(2)),
        },
    };
}

/**
 * Detecta flags de qualidade/suspeita em um lead.
 * @param {{ vaga: string, descricao: string, created_at: string, faixa_salarial: string }} vaga
 * @returns {string[]}  array de flag codes
 */
export function detectSuspiciousFlags(vaga = {}) {
    const flags = [];
    const descLen = String(vaga.descricao || '').replace(/<[^>]+>/g, '').trim().length;
    if (descLen > 0 && descLen < 200) flags.push('description_too_short');

    const title = norm(vaga.vaga || '');
    const genericTitles = ['vaga', 'oportunidade', 'profissional', 'analista', 'desenvolvedor', 'vaga de emprego'];
    if (genericTitles.includes(title)) flags.push('generic_title');

    if (vaga.created_at) {
        const ageDays = (Date.now() - new Date(vaga.created_at).getTime()) / 86400000;
        if (ageDays > 90) flags.push('reposted_90d');
    }

    return flags;
}
