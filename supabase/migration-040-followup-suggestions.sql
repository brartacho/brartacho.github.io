-- ============================================================
-- Migration 040 — Follow-up sugestões + drag thresholds
-- ============================================================

-- stage_drag_thresholds no candidate_profile
ALTER TABLE candidate_profile
  ADD COLUMN IF NOT EXISTS stage_drag_thresholds JSONB NOT NULL DEFAULT
    '{"Aplicado":10,"Triagem":14,"Teste":7,"Entrevista com RH":10,"Entrevista Técnica":10,"Entrevista com Gestor":7,"Proposta":5}'::jsonb;

-- followup_suggestions
CREATE TABLE IF NOT EXISTS followup_suggestions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      UUID        NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  days_idle           INT         NOT NULL,
  current_stage       TEXT,
  suggested_message   TEXT,
  status              TEXT        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','sent','dismissed','snoozed')),
  reason              TEXT        NOT NULL DEFAULT 'drag'
                                  CHECK (reason IN ('drag','rejection_ack')),
  sent_at             TIMESTAMPTZ,
  sent_via            TEXT,
  snoozed_until       TIMESTAMPTZ
);

-- Garante no máximo 1 sugestão pendente por candidatura
CREATE UNIQUE INDEX IF NOT EXISTS followup_suggestions_one_pending
  ON followup_suggestions(application_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_followup_suggestions_status ON followup_suggestions(status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_followup_suggestions_app    ON followup_suggestions(application_id);

ALTER TABLE followup_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON followup_suggestions FOR ALL TO service_role USING (true) WITH CHECK (true);
