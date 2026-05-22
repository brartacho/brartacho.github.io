-- ============================================================
-- Migration 025 — Perfil do candidato (base do Radar de Vagas)
-- Executar no SQL Editor do Supabase
-- ============================================================
--
-- Fonte única do perfil usada para pontuar a aderência das vagas
-- capturadas no Radar. Registro único (singleton): a aplicação lê/grava
-- sempre a linha mais recente.
-- ============================================================

CREATE TABLE IF NOT EXISTS candidate_profile (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nivel_alvo        TEXT,                          -- ex: 'Pleno'
  skills_core       JSONB       NOT NULL DEFAULT '[]',  -- domina
  skills_evolucao   JSONB       NOT NULL DEFAULT '[]',  -- diferencial (não é gap)
  gaps              JSONB       NOT NULL DEFAULT '[]',
  setores           JSONB       NOT NULL DEFAULT '[]',  -- HealthTech/LIS, ERP/WMS/PDV
  modalidade_pref   TEXT,
  contratacao_pref  TEXT,
  localizacao       TEXT,
  keywords          JSONB       NOT NULL DEFAULT '[]',
  diferenciais      JSONB       NOT NULL DEFAULT '[]',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE candidate_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role only"
  ON candidate_profile
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
