// ============================================================
// Radar de Vagas — provider de IA plugável (modo automático opcional)
// ============================================================
// Padrão = SEM chave: a análise é feita via MCP/Claude Code (custo zero).
// Opcional = COM chave: se LLM_API_KEY estiver setada, chama um endpoint
// compatível com a API OpenAI (`/chat/completions`). Apontando LLM_BASE_URL
// para um proxy LiteLLM, ganha-se multi-provider (Claude/GPT/Gemini/
// DeepSeek/Grok) trocando apenas LLM_MODEL — sem SDK extra.
//
// Env vars:
//   LLM_API_KEY   (obrigatória p/ ligar o modo automático)
//   LLM_BASE_URL  (default: https://api.openai.com/v1 — use o proxy LiteLLM)
//   LLM_MODEL     (default: gpt-4o-mini — ex.: claude-..., gemini/..., deepseek/...)
// ============================================================

import { buildAnalysisPrompt, parseAnalysisJson } from './radar-prompt.js';

export function isConfigured() {
    return Boolean(process.env.LLM_API_KEY);
}

export function providerInfo() {
    return {
        configured: isConfigured(),
        base_url: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
        model: process.env.LLM_MODEL || 'gpt-4o-mini',
    };
}

// Chama o LLM e devolve a análise já parseada. Lança se não configurado.
export async function analyze(vaga, profile) {
    if (!isConfigured()) {
        throw new Error('IA automática não configurada (defina LLM_API_KEY ou use o modo MCP/manual)');
    }
    const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = process.env.LLM_MODEL || 'gpt-4o-mini';
    const prompt = buildAnalysisPrompt(vaga, profile);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    let resp;
    try {
        resp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            signal: ctrl.signal,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.LLM_API_KEY}`,
            },
            body: JSON.stringify({
                model,
                temperature: 0.2,
                messages: [
                    { role: 'system', content: 'Você é um consultor técnico de QA e carreira. Responda apenas com JSON válido.' },
                    { role: 'user', content: prompt },
                ],
            }),
        });
    } finally {
        clearTimeout(timer);
    }

    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`LLM ${resp.status}: ${detail.slice(0, 300)}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Resposta do LLM sem conteúdo');
    return parseAnalysisJson(content);
}
