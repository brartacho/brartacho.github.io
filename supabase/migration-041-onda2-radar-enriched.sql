-- ============================================================
-- Migration 041 — Onda 2: Radar enriquecido
-- ============================================================

-- Banco reutilizável de perguntas e respostas (item K)
CREATE TABLE IF NOT EXISTS interview_qa (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  question              TEXT        NOT NULL,
  answer                TEXT,
  category              TEXT        CHECK (category IN ('rh','tecnica','comportamental')),
  tags                  TEXT[],
  source_vaga_id        UUID        REFERENCES vaga_radar(id) ON DELETE SET NULL,
  source_application_id UUID        REFERENCES job_applications(id) ON DELETE SET NULL,
  times_used            INT         NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_interview_qa_tags     ON interview_qa USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_interview_qa_category ON interview_qa(category);
ALTER TABLE interview_qa ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON interview_qa FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Flags de vaga suspeita no Radar (item Q)
ALTER TABLE vaga_radar
  ADD COLUMN IF NOT EXISTS suspicious_flags JSONB NOT NULL DEFAULT '[]'::jsonb;
  -- valores possíveis: "reposted_90d", "description_too_short", "salary_below_market", "generic_title"

-- Extensões do candidate_profile (itens B, H, O, P)
ALTER TABLE candidate_profile
  ADD COLUMN IF NOT EXISTS auto_archive_em_processo_days  INT     NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS auto_archive_recusado          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS message_pending_alert_hours    INT     NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS daily_digest_enabled           BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS stages_template                JSONB   NOT NULL DEFAULT
    '["Aplicado","Triagem","Entrevista com RH","Entrevista Técnica","Entrevista com Gestor","Teste","Proposta"]'::jsonb;
