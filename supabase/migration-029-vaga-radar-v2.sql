-- ============================================================
-- Migration 029 — vaga_radar: novos campos, status arquivada, tipos expandidos
-- Aplicar no SQL Editor do Supabase (projeto kbtbvcqlqwzgfduxtuwr)
-- ============================================================

-- Novos campos
ALTER TABLE vaga_radar
  ADD COLUMN IF NOT EXISTS requires_cnh TEXT,
  ADD COLUMN IF NOT EXISTS fit_analysis TEXT,
  ADD COLUMN IF NOT EXISTS adapted_cv_id UUID REFERENCES cv_versions(id) ON DELETE SET NULL;

-- Expandir CHECK de status para incluir 'arquivada' e manter 'promovida'
ALTER TABLE vaga_radar DROP CONSTRAINT IF EXISTS vaga_radar_status_check;
ALTER TABLE vaga_radar ADD CONSTRAINT vaga_radar_status_check
  CHECK (status IN ('novo','avaliada','promovida','descartada','arquivada'));

-- Expandir CHECK de tipo_contratacao para tipos brasileiros completos
ALTER TABLE vaga_radar DROP CONSTRAINT IF EXISTS vaga_radar_tipo_contratacao_check;
ALTER TABLE vaga_radar ADD CONSTRAINT vaga_radar_tipo_contratacao_check
  CHECK (tipo_contratacao IN ('CLT','PJ','Freelancer','Cooperado','Temporário','Estágio','Autônomo'));
