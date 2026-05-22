-- ============================================================
-- Migration 028 — Search config e preferências expandidas no candidate_profile
-- Aplicar no SQL Editor do Supabase (projeto kbtbvcqlqwzgfduxtuwr)
-- ============================================================

ALTER TABLE candidate_profile
  ADD COLUMN IF NOT EXISTS cnh JSONB NOT NULL DEFAULT '{"has":false,"categories":[]}',
  ADD COLUMN IF NOT EXISTS contratacao_prefs JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS search_platforms JSONB NOT NULL DEFAULT '[{"id":"linkedin","label":"LinkedIn","enabled":true},{"id":"gupy","label":"Gupy","enabled":true},{"id":"indeed","label":"Indeed","enabled":false},{"id":"maringa","label":"Empregos Maringá","enabled":false},{"id":"infojobs","label":"InfoJobs","enabled":false}]',
  ADD COLUMN IF NOT EXISTS search_min_score INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS auto_delete_discarded_days INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS auto_delete_stale_days INTEGER NOT NULL DEFAULT 90;

-- Migrar contratacao_pref (string legado) → contratacao_prefs (array novo)
UPDATE candidate_profile
SET contratacao_prefs = jsonb_build_array(contratacao_pref)
WHERE contratacao_pref IS NOT NULL
  AND contratacao_prefs = '[]'::jsonb;
