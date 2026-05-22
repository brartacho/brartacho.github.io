-- ============================================================
-- Migration 030 — cv_versions: metadata de busca e adaptação de CV
-- Aplicar no SQL Editor do Supabase (projeto kbtbvcqlqwzgfduxtuwr)
-- ============================================================

ALTER TABLE cv_versions
  ADD COLUMN IF NOT EXISTS target_role      TEXT,
  ADD COLUMN IF NOT EXISTS search_keywords  JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS search_platforms JSONB,
  ADD COLUMN IF NOT EXISTS source_vaga_id   UUID REFERENCES vaga_radar(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS adaptation_notes TEXT;
