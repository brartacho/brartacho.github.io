-- ============================================================
-- Migration 039 — Onda 1: fundação de candidatura inteligente
-- Novos campos em job_applications + platform_settings +
-- candidate_areas + quick_answers
-- ============================================================

-- ── job_applications: novos campos ───────────────────────────
ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS platform               TEXT,
  ADD COLUMN IF NOT EXISTS origin_radar_id        UUID REFERENCES vaga_radar(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS application_message_text     TEXT,
  ADD COLUMN IF NOT EXISTS application_message_sent     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_filled_fields     JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_job_applications_platform       ON job_applications(platform) WHERE platform IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_applications_origin_radar   ON job_applications(origin_radar_id) WHERE origin_radar_id IS NOT NULL;

-- ── platform_settings ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_settings (
  fonte           TEXT        PRIMARY KEY,
  display_name    TEXT        NOT NULL,
  url_pattern     TEXT,
  char_limit      INT         NOT NULL DEFAULT 0,      -- 0 = sem limite / não usa campo de texto
  field_name      TEXT,                                -- nome do campo na plataforma
  message_required BOOLEAN   NOT NULL DEFAULT FALSE,
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  notes           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON platform_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO platform_settings (fonte, display_name, url_pattern, char_limit, field_name) VALUES
  ('gupy',      'Gupy',           'gupy.io',            2000, 'Por que você quer trabalhar aqui?'),
  ('linkedin',  'LinkedIn',       'linkedin.com/jobs',   300, 'Nota para o recrutador'),
  ('email',     'Email',          NULL,                    0, NULL),
  ('indeed',    'Indeed',         'indeed.com.br',       3000, 'Carta de apresentação'),
  ('catho',     'Catho',          'catho.com.br',        1500, 'Mensagem para empresa'),
  ('infojobs',  'InfoJobs',       'infojobs.com.br',     1000, 'Carta de candidatura'),
  ('maringa',   'Maringá.com',    'vagas.maringa.com',      0, NULL),
  ('manual',    'Aplicação direta', NULL,                   0, NULL)
ON CONFLICT (fonte) DO NOTHING;

-- ── candidate_areas ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candidate_areas (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL UNIQUE,
  label           TEXT        NOT NULL,
  description     TEXT,
  is_primary      BOOLEAN     NOT NULL DEFAULT FALSE,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  profile_override JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE candidate_areas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON candidate_areas FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO candidate_areas (name, label, description, is_primary) VALUES
  ('qa-cs',      'QA / Customer Success', 'Qualidade de software, automação, SDET, CS',      TRUE),
  ('logistica',  'Logística / Operações',  'Coordenação logística, WMS, ERP, operações',      FALSE)
ON CONFLICT (name) DO NOTHING;

-- ── quick_answers ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quick_answers (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id         UUID        REFERENCES candidate_areas(id) ON DELETE SET NULL,
  slug            TEXT        NOT NULL,
  display_name    TEXT        NOT NULL,
  value           TEXT        NOT NULL,
  sensitive       BOOLEAN     NOT NULL DEFAULT FALSE,
  use_count       INT         NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices únicos parciais: permite slug global (area_id IS NULL) sem colisão
CREATE UNIQUE INDEX IF NOT EXISTS quick_answers_global_slug ON quick_answers(slug)          WHERE area_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quick_answers_area_slug   ON quick_answers(area_id, slug) WHERE area_id IS NOT NULL;

ALTER TABLE quick_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON quick_answers FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Seed: respostas globais (sem área)
INSERT INTO quick_answers (slug, display_name, value) VALUES
  ('pretensao_clt',   'Pretensão CLT',        'R$ 8.000 a R$ 10.000 + benefícios'),
  ('pretensao_pj',    'Pretensão PJ',          'R$ 80/hora ou R$ 13.000/mês'),
  ('disponibilidade', 'Disponibilidade',       'Imediata após aviso prévio (30 dias)'),
  ('cnh',             'CNH',                   'Sim, categoria B, ativa'),
  ('pcd',             'PCD',                   'Não'),
  ('modalidade',      'Modalidade preferida',  'Remoto ou híbrido'),
  ('idiomas',         'Idiomas',               'Português (nativo), Inglês (avançado)'),
  ('linkedin',        'LinkedIn',              'https://linkedin.com/in/bartacho'),
  ('portfolio',       'Portfólio',             'https://artacho.dev')
ON CONFLICT DO NOTHING;
