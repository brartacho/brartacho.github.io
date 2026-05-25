-- ============================================================
-- Onda 8 — Memória de contexto evolutiva
-- ============================================================

-- Notas de contexto livre (insights rápidos sobre candidatura/empresa/entrevistador)
create table if not exists context_notes (
    id             uuid primary key default gen_random_uuid(),
    entity_type    text not null,                              -- 'application' | 'lead' | 'company' | 'interviewer' | 'global'
    entity_id      text,                                       -- uuid da entidade (null para 'global')
    note           text not null,
    tags           text[] default '{}',
    importance     int default 2,                              -- 1-5 (5 = crítico)
    created_at     timestamptz default now(),
    updated_at     timestamptz default now()
);

create index if not exists idx_context_notes_entity
    on context_notes(entity_type, entity_id);

-- Resumos mensais de contexto (gerados por IA, comprimem notas + candidaturas do mês)
create table if not exists context_summaries (
    id             uuid primary key default gen_random_uuid(),
    scope          text not null,                              -- 'month' | 'quarter' | 'application' | 'global'
    scope_ref      text,                                       -- '2026-05', 'application:uuid', null para global
    title          text,
    summary_md     text,                                       -- Markdown (exibido no painel)
    highlights     text[],                                     -- bullet points principais
    entity_ids     text[],                                     -- candidaturas incluídas no resumo
    keywords       text[],                                     -- termos extraídos para busca
    provider       text,                                       -- provider LLM usado
    generated_at   timestamptz default now(),
    valid_until    timestamptz                                 -- quando expirar (forçar regeneração)
);

create index if not exists idx_context_summaries_scope
    on context_summaries(scope, scope_ref);

-- Contexto consolidado por candidatura (usado como preamble nos prompts)
create table if not exists application_context (
    id             uuid primary key default gen_random_uuid(),
    application_id uuid not null references job_applications(id) on delete cascade unique,
    context_md     text,                                       -- memória consolidada desta candidatura
    last_interaction_at timestamptz,
    interaction_count int default 0,
    updated_at     timestamptz default now()
);

-- Gatilho que atualiza application_context.updated_at
create or replace function touch_application_context()
returns trigger language plpgsql as $$
begin
    update application_context set updated_at = now() where application_id = new.application_id;
    return new;
end;
$$;

-- Trigger ao atualizar interview_sessions
create trigger trg_touch_ctx_interview
    after insert or update on interview_sessions
    for each row execute function touch_application_context();
