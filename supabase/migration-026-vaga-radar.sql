-- ============================================================
-- Migration 026 — Radar de Vagas (descoberta + pontuação)
-- Executar no SQL Editor do Supabase
-- ============================================================
--
-- Leads de vagas capturadas ANTES de virar candidatura. Pontuados por
-- regras (fit_score_regras) e, opcionalmente, refinados por IA
-- (fit_score_ia). Ao "promover", cria-se uma linha em job_applications
-- e guarda-se o vínculo em promoted_application_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS vaga_radar (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa                TEXT        NOT NULL,
  vaga                   TEXT,
  link_vaga              TEXT,
  descricao              TEXT,
  fonte                  TEXT        NOT NULL DEFAULT 'linkedin',
  modalidade             TEXT        CHECK (modalidade IN ('Presencial','Híbrida','Remota')),
  tipo_contratacao       TEXT        CHECK (tipo_contratacao IN ('CLT','PJ','Freelancer')),
  nivel                  TEXT,
  fit_score_regras       INTEGER,
  fit_score_ia           INTEGER,
  fit_score              INTEGER,                       -- valor final exibido
  keywords_match         JSONB       NOT NULL DEFAULT '[]',
  gaps                   JSONB       NOT NULL DEFAULT '[]',
  positioning            TEXT,
  status                 TEXT        NOT NULL DEFAULT 'novo'
                                     CHECK (status IN ('novo','avaliada','promovida','descartada')),
  motivo_descarte        TEXT,
  analyzed_at            TIMESTAMPTZ,
  promoted_application_id UUID       REFERENCES job_applications(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vaga_radar_status    ON vaga_radar(status);
CREATE INDEX IF NOT EXISTS idx_vaga_radar_fit_score ON vaga_radar(fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_vaga_radar_created   ON vaga_radar(created_at DESC);

ALTER TABLE vaga_radar ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role only"
  ON vaga_radar
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
