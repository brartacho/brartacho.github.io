// Constrói o prompt para geração de mensagem de candidatura personalizada

export function buildMessagePrompt({ empresa, vaga, descricao, positioning, keywords_match, gaps, fonte, charLimit, platformDisplay, profile, quickAnswers, extraInstruction }) {
    const platformInstr = charLimit > 0
        ? `A mensagem deve ter NO MÁXIMO ${charLimit} caracteres (contando espaços). Seja conciso.`
        : 'Escreva uma mensagem completa sem limite de caracteres.';

    const platform = platformDisplay || fonte || 'não especificada';
    const skillsCore = (profile?.skills_core || []).slice(0, 10).join(', ') || 'não informado';
    const diferenciais = (profile?.diferenciais || []).slice(0, 5).join(', ') || '';
    const nivel = profile?.nivel_alvo || 'Pleno/Sênior';
    const modalidade = profile?.modalidade_pref || 'Remoto/Híbrido';

    const answersBlock = (quickAnswers || []).length > 0
        ? `\nRESPOSTAS PADRÃO DO CANDIDATO (use se relevante):\n${(quickAnswers || []).map(q => `- ${q.display_name}: ${q.value}`).join('\n')}`
        : '';

    const keywordsBlock = (keywords_match || []).length > 0
        ? `\nKeywords compatíveis com o perfil: ${keywords_match.slice(0, 12).join(', ')}`
        : '';

    const gapsBlock = (gaps || []).length > 0
        ? `\nGaps identificados (não enfatize, mas não omita se perguntado): ${gaps.slice(0, 5).join(', ')}`
        : '';

    const positioningBlock = positioning
        ? `\nAnálise de posicionamento (use como guia, não copie literalmente):\n${positioning.slice(0, 600)}`
        : '';

    const descricaoBlock = descricao
        ? `\nDescrição da vaga (primeiros 1500 chars):\n${descricao.slice(0, 1500)}`
        : '';

    const extraBlock = extraInstruction
        ? `\nINSTRUÇÃO EXTRA DO USUÁRIO (prioridade máxima): ${String(extraInstruction).slice(0, 300)}`
        : '';

    return `Você é um assistente especializado em carreira tech. Gere uma mensagem de candidatura personalizada.

VAGA:
Empresa: ${empresa}
Cargo: ${vaga || 'não especificado'}
Plataforma de envio: ${platform}
${descricaoBlock}
${positioningBlock}
${keywordsBlock}
${gapsBlock}

CANDIDATO:
Nível: ${nivel}
Skills principais: ${skillsCore}
${diferenciais ? `Diferenciais: ${diferenciais}` : ''}
Modalidade preferida: ${modalidade}
${answersBlock}
${extraBlock}

INSTRUÇÕES DE ESCRITA:
- ${platformInstr}
- Português do Brasil, primeira pessoa, tom profissional mas humano e direto
- Mencione 1-2 skills ou experiências específicas que se alinham à vaga
- EVITE aberturas genéricas ("venho por meio desta", "gostaria de me candidatar")
- EVITE bullet points ou listas — escreva em prosa fluída
- Finalize com disponibilidade para conversa ou entrevista
- Responda APENAS com o texto da mensagem, sem aspas, sem prefixos, sem explicações`.trim();
}

export function parseMessageResponse(content) {
    if (!content) return null;
    return content
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim();
}

/**
 * Gera mensagem de candidatura sem LLM, a partir dos dados disponíveis.
 * Usada como fallback quando nenhum provider está configurado.
 */
export function buildTemplateMessage({ empresa, vaga, keywords_match, positioning, charLimit, profile }) {
    const skills = (profile?.skills_core || []).slice(0, 5);
    const kw = (keywords_match || [])
        .filter(k => !skills.some(s => s.toLowerCase() === k.toLowerCase()))
        .slice(0, 3);
    const highlights = [...skills.slice(0, 2), ...kw.slice(0, 2)].slice(0, 3);
    const posNote = positioning
        ? positioning.split(/[.!?]/)[0].trim().replace(/^[^a-zA-ZÀ-ÿ]+/, '').slice(0, 100)
        : null;

    const parts = [];
    parts.push(vaga
        ? `Olá! Me candidato à vaga de ${vaga} na ${empresa}.`
        : `Olá! Tenho interesse em oportunidades na ${empresa}.`);
    if (highlights.length > 0) parts.push(`Tenho experiência com ${highlights.join(', ')}.`);
    if (posNote && posNote.length > 20) parts.push(`${posNote}.`);
    parts.push('Fico à disposição para conversa. Obrigado!');

    let msg = parts.join(' ');

    if (charLimit > 0 && msg.length > charLimit) {
        const short = [];
        short.push(vaga ? `Me candidato à ${vaga} na ${empresa}.` : `Interesse em oportunidades na ${empresa}.`);
        if (highlights.length > 0) short.push(`Skills: ${highlights.join(', ')}.`);
        short.push('Disponível para conversa!');
        msg = short.join(' ');
        if (msg.length > charLimit) msg = msg.slice(0, charLimit - 1) + '…';
    }

    return msg;
}
