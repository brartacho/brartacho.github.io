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
    const score = Math.max(0, Math.min(10, Math.round(total * 10) / 10));

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
 * N24 — Fit reverso: quanto a EMPRESA/VAGA se alinha ao candidato.
 * @param {object} vaga    { modalidade, tipo_contratacao, faixa_salarial, fit_score }
 * @param {object} profile { modalidade_pref, reverse_fit_weights, nivel_alvo,
 *                           expected_salary_min, expected_salary_max }
 * @returns {{ score: number, breakdown: object, warnings: string[] }}
 */
export function computeReverseFit(vaga = {}, profile = {}) {
    const weights = Object.assign({
        modalidade: 0.25,
        salario:    0.30,
        contratacao: 0.20,
        nivel:      0.25,
    }, profile.reverse_fit_weights || {});

    const warnings = [];
    const breakdown = {};

    // Modalidade
    const modVaga = vaga.modalidade || '';
    const modPref = profile.modalidade_pref || '';
    if (!modVaga) {
        breakdown.modalidade = 0.6;
    } else if (modVaga === 'Remota') {
        breakdown.modalidade = modPref === 'Remota' || !modPref ? 1 : 0.85;
    } else if (modVaga === 'Híbrida') {
        breakdown.modalidade = modPref === 'Híbrida' ? 1 : (modPref === 'Remota' ? 0.65 : 0.8);
    } else {
        breakdown.modalidade = modPref === 'Presencial' ? 1 : 0.4;
        if (modPref === 'Remota') warnings.push('Presencial — preferência é remoto');
    }

    // Salário (heurística: parse faixa_salarial)
    const fs = String(vaga.faixa_salarial || '');
    const nums = [...fs.matchAll(/[\d.,]+/g)].map(m => parseFloat(m[0].replace(',','.')));
    const salMin = nums[0] || 0;
    const salMax = nums[1] || salMin;
    const expMin = profile.expected_salary_min || 0;
    const expMax = profile.expected_salary_max || expMin;
    if (!salMin || !expMin) {
        breakdown.salario = 0.5;
    } else {
        const overlap = Math.min(salMax, expMax) - Math.max(salMin, expMin);
        const range = Math.max(salMax, expMax) - Math.min(salMin, expMin);
        const ratio = range > 0 ? Math.max(0, overlap / range) : 0;
        breakdown.salario = Math.min(1, ratio + (salMax >= expMin ? 0.2 : 0));
        if (salMax < expMin) warnings.push('Faixa salarial abaixo da expectativa');
    }

    // Contratação
    const tipoVaga = vaga.tipo_contratacao || '';
    const tipoPref = profile.contratacao_pref || '';
    breakdown.contratacao = !tipoVaga || !tipoPref ? 0.6 : tipoVaga === tipoPref ? 1 : 0.5;

    // Nível
    const nivelScore = vaga.fit_score ? Math.min(1, vaga.fit_score / 10) : 0.6;
    breakdown.nivel = nivelScore;

    // Score ponderado
    const total = Object.entries(weights).reduce((sum, [k, w]) => sum + (breakdown[k] || 0.5) * w, 0);
    const score = Math.max(0, Math.min(10, Math.round(total * 100) / 10));

    return { score, breakdown, warnings };
}

/**
 * N42 — Alinhamento de valores: quanto a vaga alinha com os valores do candidato.
 * @param {object} vaga    { modalidade, tipo_contratacao, faixa_salarial, fit_score, descricao }
 * @param {object} profile { values_weights, modalidade_pref, expected_salary_min, expected_salary_max,
 *                           setores, contratacao_pref }
 * @returns {{ score: number, breakdown: object }}
 */
export function computeAlignmentScore(vaga = {}, profile = {}) {
    const weights = Object.assign({
        salario: 0.30, proposito: 0.10, wlb: 0.20,
        growth: 0.20, seguranca: 0.10, autonomia: 0.10,
    }, profile.values_weights || {});

    const desc = norm(String(vaga.descricao || '') + ' ' + String(vaga.vaga || ''));
    const breakdown = {};

    // Salário — quanto da faixa anunciada cobre a expectativa
    const fs = String(vaga.faixa_salarial || '');
    const nums = [...fs.matchAll(/[\d.,]+/g)].map(m => parseFloat(m[0].replace(',','.')));
    const salMax = nums[1] || nums[0] || 0;
    const expMin = profile.expected_salary_min || 0;
    breakdown.salario = !salMax || !expMin ? 0.5 : salMax >= expMin ? Math.min(1, salMax / expMin * 0.7 + 0.3) : salMax / expMin;

    // WLB — presença de keywords de qualidade de vida
    const wlbKws = ['flexivel','flex','remoto','home office','work from home','saude','bem-estar','wellbeing','folga'];
    breakdown.wlb = wlbKws.filter(k => desc.includes(k)).length >= 2 ? 0.9 :
                    wlbKws.some(k => desc.includes(k)) ? 0.65 : 0.4;
    if (vaga.modalidade === 'Remota') breakdown.wlb = Math.max(breakdown.wlb, 0.85);

    // Propósito — setor ou keywords de impacto
    const propKws = ['impacto','proposito','sustentavel','social','educacao','saude','fintech','govtech'];
    const setores = arr(profile.setores).map(s => norm(s));
    const vagaSetorMatch = setores.some(s => desc.includes(s));
    breakdown.proposito = vagaSetorMatch ? 0.9 : propKws.some(k => desc.includes(k)) ? 0.7 : 0.5;

    // Crescimento — menção a desenvolvimento profissional
    const growthKws = ['desenvolvimento','carreira','treinamento','mentoria','grow','learning','evolucao','certificado'];
    breakdown.growth = growthKws.filter(k => desc.includes(k)).length >= 2 ? 0.85 :
                       growthKws.some(k => desc.includes(k)) ? 0.65 : 0.45;

    // Segurança — empresa sólida (não temos dados diretos, usa fit_score como proxy)
    const fs2 = vaga.fit_score || 0;
    breakdown.seguranca = fs2 >= 7 ? 0.8 : fs2 >= 5 ? 0.65 : 0.5;

    // Autonomia — keywords de autonomia/liderança técnica
    const autoKws = ['autonomia','lideranca','self-managed','tech lead','squad','ownership','decisao'];
    breakdown.autonomia = autoKws.some(k => desc.includes(k)) ? 0.8 : 0.55;

    const total = Object.entries(weights).reduce((sum, [k, w]) => sum + (breakdown[k] || 0.5) * w, 0);
    const score = Math.max(0, Math.min(10, Math.round(total * 100) / 10));

    return { score, breakdown };
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
