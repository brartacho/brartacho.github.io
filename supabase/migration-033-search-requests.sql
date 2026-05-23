-- migration-033: tabela de fila de requisições de busca automática de vagas
CREATE TABLE IF NOT EXISTS search_requests (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  platforms       TEXT[]      NOT NULL DEFAULT '{}',
  keywords        TEXT[],
  max_results     INTEGER,
  dry_run         BOOLEAN     NOT NULL DEFAULT false,
  status          TEXT        NOT NULL DEFAULT 'pending',
  result          JSONB,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_search_requests_status  ON search_requests(status);
CREATE INDEX IF NOT EXISTS idx_search_requests_created ON search_requests(created_at DESC);

ALTER TABLE search_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON search_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
