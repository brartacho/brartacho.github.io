-- ============================================================
-- Onda 7 — Gravação e análise de entrevistas
-- ============================================================

-- Sessões de entrevista (uma por candidatura/etapa)
create table if not exists interview_sessions (
    id                  uuid primary key default gen_random_uuid(),
    application_id      uuid not null references job_applications(id) on delete cascade,
    stage_name          text,                                  -- etapa do processo: 'rh' | 'tecnica' | 'gestor' | 'final'
    interview_at        timestamptz,
    interviewer_name    text,
    interviewer_email   text,
    notes_before        text,                                  -- anotações do candidato antes da entrevista
    notes_after         text,                                  -- anotações pós-entrevista (sentimento, impressões)
    recording_available boolean default false,
    status              text default 'planned',                -- 'planned' | 'in_progress' | 'done' | 'cancelled'
    created_at          timestamptz default now(),
    updated_at          timestamptz default now()
);

create index if not exists idx_interview_sessions_app
    on interview_sessions(application_id, interview_at desc);

-- Segmentos de transcrição (chunks de ~30s cada)
create table if not exists interview_transcripts (
    id              uuid primary key default gen_random_uuid(),
    session_id      uuid not null references interview_sessions(id) on delete cascade,
    chunk_index     int not null,
    speaker         text default 'unknown',                    -- 'candidate' | 'interviewer' | 'unknown'
    text            text not null,
    start_seconds   numeric,
    end_seconds     numeric,
    confidence      numeric,                                   -- 0-1 (da API de transcrição)
    created_at      timestamptz default now()
);

create index if not exists idx_transcripts_session
    on interview_transcripts(session_id, chunk_index);

-- Análises de entrevista (geradas por IA após a sessão)
create table if not exists interview_analyses (
    id              uuid primary key default gen_random_uuid(),
    session_id      uuid not null references interview_sessions(id) on delete cascade,
    analysis_type   text default 'full',                       -- 'full' | 'quick' | 'feedback_parse'
    overall_score   numeric,                                   -- 0-10
    communication   numeric,                                   -- 0-10
    technical       numeric,                                   -- 0-10
    behavioral      numeric,                                   -- 0-10
    questions_asked jsonb,                                     -- [{question, answer_given, ideal_answer, score}]
    strengths       text[],
    improvements    text[],
    red_flags       text[],
    next_steps      text,
    full_feedback   text,                                      -- feedback em prosa
    raw_transcript  text,                                      -- transcrição completa (texto)
    provider        text,                                      -- provider LLM usado
    generated_at    timestamptz default now()
);

create index if not exists idx_analyses_session
    on interview_analyses(session_id);
