// ============================================================
// Radar de Vagas — prompt de análise e parser do JSON de retorno
// ============================================================
// Centraliza (1) a montagem do prompt usado tanto no modo manual/MCP
// (copiar para o Claude Code) quanto no modo automático (LiteLLM), e
// (2) o parse/validação do JSON devolvido. Shape alinhado ao JobAnalysis
// do curriculo_ia (CandiPilot) para convergência futura.
// ============================================================

const list = (v) => (Array.isArray(v) ? v : []).join(', ') || '—';

export function buildAnalysisPrompt(vaga = {}, profile = {}) {
    return `Atue como consultor técnico e de carreira. Analise a aderência da vaga abaixo ao perfil do candidato, com honestidade — não invente experiência, formação, certificação ou senioridade que não constem no perfil.

# Perfil do candidato
- Nível-alvo: ${profile.nivel_alvo || '—'}
- Domina: ${list(profile.skills_core)}
- Em evolução (diferencial, não gap): ${list(profile.skills_evolucao)}
- Gaps conhecidos: ${list(profile.gaps)}
- Setores de diferencial: ${list(profile.setores)}
- Preferências: ${profile.modalidade_pref || '—'} / ${profile.contratacao_pref || '—'} / ${profile.localizacao || '—'}
- Diferenciais: ${list(profile.diferenciais)}

# Vaga
- Empresa: ${vaga.empresa || '—'}
- Título: ${vaga.vaga || '—'}
- Modalidade: ${vaga.modalidade || '—'} | Contratação: ${vaga.tipo_contratacao || '—'} | Nível: ${vaga.nivel || '—'}
- Descrição:
"""
${(vaga.descricao || '').slice(0, 6000)}
"""

# Tarefa
Retorne SOMENTE um objeto JSON válido (sem markdown, sem comentários) com EXATAMENTE estas chaves:
{
  "summary": "resumo curto da vaga",
  "seniority_inferred": "junior|pleno|senior|especialista|indefinido",
  "fit_score": 0.0,                     // decimal 0.0–10.0 (uma casa) de aderência ao perfil
  "fit_analysis": "parágrafo 2–4 frases: pontos fortes do fit, principais gaps e avaliação honesta",
  "required_keywords": ["..."],         // requisitos obrigatórios
  "nice_to_have_keywords": ["..."],     // diferenciais
  "gaps": ["..."],                      // o que a vaga pede e o candidato não tem
  "positioning": "estratégia honesta de posicionamento (2–3 frases)",
  "rh_questions": ["..."],              // perguntas para o RH
  "tech_questions": ["..."],            // perguntas para o gestor técnico
  "risks": ["..."]                      // riscos/ambiguidades
}
Regras: não aumentar senioridade artificialmente; tratar skills "em evolução" como positivo; classificar gaps com honestidade.`;
}

// Extrai e valida o JSON de análise vindo do modelo / Claude Code.
export function parseAnalysisJson(input) {
    let text = String(input ?? '').trim();
    if (!text) throw new Error('Resposta vazia');

    // remove cercas ```json ... ```
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();

    // recorta do primeiro { ao último }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) throw new Error('JSON não encontrado na resposta');

    let obj;
    try {
        obj = JSON.parse(text.slice(first, last + 1));
    } catch (e) {
        throw new Error(`JSON inválido: ${e.message}`);
    }

    const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : []);
    let fit = Number(obj.fit_score);
    if (!Number.isFinite(fit)) fit = null;
    else fit = Math.max(0, Math.min(10, Math.round(fit * 10) / 10));

    return {
        summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
        seniority_inferred: typeof obj.seniority_inferred === 'string' ? obj.seniority_inferred.trim() : '',
        fit_score: fit,
        fit_analysis: typeof obj.fit_analysis === 'string' ? obj.fit_analysis.trim() : '',
        required_keywords: strArr(obj.required_keywords),
        nice_to_have_keywords: strArr(obj.nice_to_have_keywords),
        gaps: strArr(obj.gaps),
        positioning: typeof obj.positioning === 'string' ? obj.positioning.trim() : '',
        rh_questions: strArr(obj.rh_questions),
        tech_questions: strArr(obj.tech_questions),
        risks: strArr(obj.risks),
    };
}
