-- ============================================================
-- Migration 032 — Search log + defaults de keywords nas plataformas
-- Aplicar no SQL Editor do Supabase (projeto kbtbvcqlqwzgfduxtuwr)
-- ============================================================

-- Histórico de execuções de busca automática
CREATE TABLE IF NOT EXISTS search_log (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              TEXT        NOT NULL,
  keywords_used         JSONB       NOT NULL DEFAULT '[]',
  found_count           INTEGER     NOT NULL DEFAULT 0,
  new_count             INTEGER     NOT NULL DEFAULT 0,
  duplicate_count       INTEGER     NOT NULL DEFAULT 0,
  below_min_score_count INTEGER     NOT NULL DEFAULT 0,
  ran_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_log_platform ON search_log(platform);
CREATE INDEX IF NOT EXISTS idx_search_log_ran_at   ON search_log(ran_at DESC);

ALTER TABLE search_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only"
  ON search_log FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Atualiza search_platforms no candidate_profile com keywords e config de busca por plataforma.
-- Executa somente se o perfil existir. Preserva last_searched_at existente.
UPDATE candidate_profile
SET search_platforms = (
  SELECT jsonb_agg(
    CASE p->>'id'
      WHEN 'linkedin' THEN p || jsonb_build_object(
        'keywords',    COALESCE(p->'keywords', '["analista de qa","qa engineer","automação de testes","analista de implantação","quality assurance analyst"]'::jsonb),
        'time_filter', COALESCE(p->>'time_filter', 'r86400'),
        'max_results', COALESCE((p->>'max_results')::int, 30)
      )
      WHEN 'gupy' THEN p || jsonb_build_object(
        'keywords',    COALESCE(p->'keywords', '["analista de qa","quality assurance","automação de testes","qa engineer"]'::jsonb),
        'max_results', COALESCE((p->>'max_results')::int, 20)
      )
      WHEN 'indeed' THEN p || jsonb_build_object(
        'keywords',    COALESCE(p->'keywords', '["analista de qa","quality assurance","qa analyst"]'::jsonb),
        'max_results', COALESCE((p->>'max_results')::int, 20)
      )
      WHEN 'maringa' THEN p || jsonb_build_object(
        'enabled',     true,
        'keywords',    COALESCE(p->'keywords', '["qualidade","analista","implantação","customer success","suporte técnico"]'::jsonb),
        'max_results', COALESCE((p->>'max_results')::int, 15)
      )
      ELSE p
    END
  )
  FROM jsonb_array_elements(search_platforms) AS p
),
updated_at = NOW()
WHERE search_platforms IS NOT NULL
  AND jsonb_array_length(search_platforms) > 0;
