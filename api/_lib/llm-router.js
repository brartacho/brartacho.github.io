// ============================================================
// LLM multi-provider router
// ============================================================
// Seleciona o melhor provider disponível para a task solicitada,
// respeita rate-limits e registra uso em llm_usage_log.
//
// task_type: 'analysis' | 'message' | 'extraction'
//   - analysis:   avaliação de vaga (precisa de raciocínio)
//   - message:    gerar mensagem de candidatura (precisa de fluência)
//   - extraction: extrair campos estruturados de texto (JSON rigoroso)
//
// Fallback chain: tenta providers em ordem de priority até um funcionar.
// Custo zero por padrão quando só providers free-tier estão configurados.
// ============================================================

import { getSupabase } from './supabase.js';

const ENV_ALIASES = {
    GROQ_API_KEY:       'groq',
    GEMINI_API_KEY:     'google',
    OPENROUTER_API_KEY: 'openrouter',
    LLM_API_KEY:        'openai',
};

// Resolve api_key_ref → valor da env var
function resolveKey(apiKeyRef) {
    if (!apiKeyRef) return null;
    // api_key_ref pode ser "GROQ_API_KEY", "LLM_API_KEY", etc.
    return process.env[apiKeyRef] || null;
}

// Cache de providers para evitar query por request
let _providersCache = null;
let _providersCacheTs = 0;
const CACHE_TTL_MS = 5 * 60_000;

async function getProviders(taskType) {
    const now = Date.now();
    if (!_providersCache || now - _providersCacheTs > CACHE_TTL_MS) {
        const { data } = await getSupabase()
            .from('llm_providers')
            .select('*')
            .eq('enabled', true)
            .order('priority');
        _providersCache = data ?? [];
        _providersCacheTs = now;
    }
    return _providersCache.filter(p =>
        !taskType || (Array.isArray(p.task_types) && p.task_types.includes(taskType))
    );
}

// Registra uso no log (fire-and-forget — não bloqueia a resposta)
async function logUsage({ providerId, taskType, tokensIn, tokensOut, latencyMs, status, errorMessage, refId }) {
    try {
        await getSupabase().from('llm_usage_log').insert({
            provider_id:    providerId,
            task_type:      taskType,
            tokens_in:      tokensIn || 0,
            tokens_out:     tokensOut || 0,
            latency_ms:     latencyMs || null,
            status:         status || 'ok',
            error_message:  errorMessage || null,
            ref_id:         refId || null,
        });
    } catch (_) { /* silencioso */ }
}

/**
 * Chama o melhor provider disponível para a task.
 * @param {{ taskType: string, messages: Array, maxTokens?: number, temperature?: number, refId?: string }} opts
 * @returns {{ content: string, provider: string, model: string, tokensIn: number, tokensOut: number }}
 */
export async function routeChat({ taskType = 'analysis', messages, maxTokens = 1500, temperature = 0.2, refId }) {
    const providers = await getProviders(taskType);
    if (!providers.length) throw new Error('Nenhum provider LLM configurado para task: ' + taskType);

    let lastError;
    for (const provider of providers) {
        const apiKey = resolveKey(provider.api_key_ref);
        if (!apiKey) continue; // sem chave → pular

        const start = Date.now();
        try {
            const baseUrl = provider.base_url.replace(/\/+$/, '');
            const resp = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    // OpenRouter requer esse header
                    ...(provider.provider === 'openrouter' ? { 'HTTP-Referer': 'https://artacho.dev', 'X-Title': 'JobSync Radar' } : {}),
                },
                body: JSON.stringify({
                    model:       provider.model,
                    messages,
                    max_tokens:  maxTokens,
                    temperature,
                }),
                signal: AbortSignal.timeout(45_000),
            });

            if (!resp.ok) {
                const detail = await resp.text().catch(() => '');
                throw new Error(`${provider.slug} HTTP ${resp.status}: ${detail.slice(0, 200)}`);
            }

            const data    = await resp.json();
            const content = data?.choices?.[0]?.message?.content;
            if (!content) throw new Error(`${provider.slug}: resposta sem conteúdo`);

            const latencyMs  = Date.now() - start;
            const tokensIn   = data.usage?.prompt_tokens    || 0;
            const tokensOut  = data.usage?.completion_tokens || 0;

            logUsage({ providerId: provider.id, taskType, tokensIn, tokensOut, latencyMs, status: 'ok', refId });

            return { content, provider: provider.slug, model: provider.model, tokensIn, tokensOut };

        } catch (e) {
            lastError = e;
            const latencyMs = Date.now() - start;
            logUsage({ providerId: provider.id, taskType, latencyMs, status: e.name === 'AbortError' ? 'timeout' : 'error', errorMessage: e.message, refId });
            console.error(`[llm-router] falha em ${provider.slug}: ${e.message} — tentando próximo`);
        }
    }

    throw new Error(`Todos os providers falharam para task ${taskType}. Último erro: ${lastError?.message}`);
}

/**
 * Info sobre providers configurados + uso de hoje (para o painel)
 */
export async function providerStats() {
    const supabase = getSupabase();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    const [{ data: providers }, { data: usage }] = await Promise.all([
        supabase.from('llm_providers').select('*').order('priority'),
        supabase.from('llm_usage_log')
            .select('provider_id, tokens_in, tokens_out, status, task_type')
            .gte('created_at', todayStart.toISOString()),
    ]);

    return (providers || []).map(p => {
        const rows      = (usage || []).filter(u => u.provider_id === p.id);
        const ok        = rows.filter(r => r.status === 'ok');
        const errors    = rows.filter(r => r.status !== 'ok');
        const tokensIn  = ok.reduce((s, r) => s + (r.tokens_in  || 0), 0);
        const tokensOut = ok.reduce((s, r) => s + (r.tokens_out || 0), 0);
        const hasKey    = Boolean(resolveKey(p.api_key_ref));
        return {
            id: p.id, slug: p.slug, display_name: p.display_name,
            provider: p.provider, model: p.model, tier: p.tier,
            priority: p.priority, enabled: p.enabled,
            task_types: p.task_types,
            max_tokens_per_day: p.max_tokens_per_day,
            api_key_configured: hasKey,
            today: { calls_ok: ok.length, calls_error: errors.length, tokens_in: tokensIn, tokens_out: tokensOut },
        };
    });
}
