-- ============================================================
-- Onda 5 — Auto-Sync de status nas plataformas
-- ============================================================

-- Sessões por plataforma (cookies/tokens Playwright, criptografados)
create table if not exists platform_sessions (
    id             uuid primary key default gen_random_uuid(),
    fonte          text not null,                          -- 'gupy' | 'linkedin' | 'indeed' | 'maringa'
    display_name   text,
    session_data   text not null,                          -- JSON cifrado com AES-256 (pgsodium) — só lido pelo MCP local
    session_type   text default 'cookie',                  -- 'cookie' | 'token' | 'credentials'
    expires_at     timestamptz,
    last_used_at   timestamptz,
    is_valid       boolean default true,
    created_at     timestamptz default now(),
    unique(fonte)
);

-- Histórico de status de cada candidatura (log imutável)
create table if not exists application_status_history (
    id             uuid primary key default gen_random_uuid(),
    application_id uuid not null references job_applications(id) on delete cascade,
    fonte          text not null,
    previous_status text,
    new_status     text not null,
    external_status text,                                  -- status bruto da plataforma
    changed_at     timestamptz default now(),
    change_source  text default 'auto_sync',               -- 'auto_sync' | 'manual' | 'webhook'
    notes          text
);

create index if not exists idx_app_status_history_app
    on application_status_history(application_id, changed_at desc);

-- Novos campos em job_applications
alter table job_applications
    add column if not exists auto_sync_enabled      boolean default true,
    add column if not exists last_synced_at          timestamptz,
    add column if not exists platform_application_id text,              -- ID da candidatura na plataforma
    add column if not exists external_status         text,              -- status cru da plataforma
    add column if not exists sync_error              text;              -- última mensagem de erro de sync

-- status_mapping em platform_settings (mapeamento externo → interno)
alter table platform_settings
    add column if not exists status_mapping jsonb default '{}'::jsonb,
    add column if not exists sync_enabled   boolean default false,
    add column if not exists sync_interval_hours int default 24;

-- Seeds de status_mapping para plataformas conhecidas
update platform_settings set status_mapping = '{
    "em_análise": "em_processo",
    "em analise": "em_processo",
    "em triagem": "em_processo",
    "aguardando": "em_processo",
    "em avaliação": "em_processo",
    "entrevista": "em_processo",
    "teste": "em_processo",
    "proposta": "em_processo",
    "aprovado": "aprovado",
    "contratado": "aprovado",
    "reprovado": "recusado",
    "não avançou": "recusado",
    "nao avancou": "recusado",
    "encerrada": "recusado",
    "vaga encerrada": "vaga_removida",
    "vaga removida": "vaga_removida"
}'::jsonb
where status_mapping = '{}'::jsonb or status_mapping is null;
