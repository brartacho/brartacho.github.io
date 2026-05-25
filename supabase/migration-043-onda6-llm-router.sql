-- ============================================================
-- Onda 6 — LLM multi-provider router
-- ============================================================

-- Configuração de cada provider LLM disponível
create table if not exists llm_providers (
    id             uuid primary key default gen_random_uuid(),
    slug           text not null unique,                   -- 'groq-llama3', 'gemini-flash', 'gpt4o-mini', 'claude-haiku', ...
    display_name   text not null,
    provider       text not null,                          -- 'openai' | 'groq' | 'google' | 'anthropic' | 'openrouter' | 'custom'
    base_url       text not null,                          -- endpoint compatível com OpenAI /chat/completions
    model          text not null,
    api_key_ref    text,                                   -- nome da env var que contém a chave (nunca a chave em si)
    task_types     text[] default '{analysis,message,extraction}'::text[],
    priority       int default 10,                         -- menor = preferido (dentro da mesma task_type)
    tier           text default 'free',                    -- 'free' | 'paid'
    max_rpm        int default 30,                         -- requests per minute (rate limit do plano)
    max_tokens_per_day int,                                -- null = sem limite
    enabled        boolean default true,
    notes          text,
    created_at     timestamptz default now(),
    updated_at     timestamptz default now()
);

-- Log de uso por chamada (para quota tracking)
create table if not exists llm_usage_log (
    id             uuid primary key default gen_random_uuid(),
    provider_id    uuid not null references llm_providers(id) on delete cascade,
    task_type      text not null,
    tokens_in      int default 0,
    tokens_out     int default 0,
    latency_ms     int,
    status         text default 'ok',                      -- 'ok' | 'error' | 'timeout'
    error_message  text,
    ref_id         text,                                   -- application_id ou lead_id que gerou a chamada
    created_at     timestamptz default now()
);

create index if not exists idx_llm_usage_provider_day
    on llm_usage_log(provider_id, created_at);
create index if not exists idx_llm_usage_task_day
    on llm_usage_log(task_type, created_at);

-- Seeds: providers free-tier prontos para uso (sem api_key_ref = requer configuração)
insert into llm_providers (slug, display_name, provider, base_url, model, tier, priority, task_types, notes) values
    ('groq-llama3-70b',  'Groq Llama-3 70B',      'groq',      'https://api.groq.com/openai/v1',          'llama3-70b-8192',              'free', 1, '{analysis,message,extraction}', 'env: GROQ_API_KEY'),
    ('groq-llama3-8b',   'Groq Llama-3 8B',        'groq',      'https://api.groq.com/openai/v1',          'llama3-8b-8192',               'free', 2, '{extraction}',                  'env: GROQ_API_KEY — tarefas leves'),
    ('gemini-flash',     'Gemini 2.0 Flash',        'google',    'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.0-flash', 'free', 3, '{analysis,message,extraction}', 'env: GEMINI_API_KEY'),
    ('openrouter-qwen',  'Qwen2.5 72B (OpenRouter)','openrouter','https://openrouter.ai/api/v1',           'qwen/qwen-2.5-72b-instruct:free','free',4, '{analysis,message}',           'env: OPENROUTER_API_KEY'),
    ('gpt4o-mini',       'GPT-4o Mini',             'openai',    'https://api.openai.com/v1',               'gpt-4o-mini',                  'paid',10, '{analysis,message,extraction}', 'env: LLM_API_KEY')
on conflict (slug) do nothing;
