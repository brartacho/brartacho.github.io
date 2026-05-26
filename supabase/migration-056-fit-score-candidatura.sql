-- ============================================================
-- Migration 056 — fit_score snapshot em job_applications
-- Copia o score do lead no momento da promoção para candidatura.
-- Candidaturas manuais ficam com NULL (esperado).
-- ============================================================

ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS fit_score NUMERIC(3,1);

-- Backfill: preenche score das candidaturas que vieram do Radar
UPDATE job_applications ja
   SET fit_score = vr.fit_score
  FROM vaga_radar vr
 WHERE ja.origin_radar_id = vr.id
   AND ja.fit_score IS NULL
   AND vr.fit_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_job_applications_fit_score
  ON job_applications(fit_score DESC NULLS LAST)
  WHERE fit_score IS NOT NULL;
