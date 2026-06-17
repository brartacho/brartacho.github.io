-- migration-058: habilita RLS nas tabelas demo (service_role only)
-- O acesso a essas tabelas é exclusivamente server-side via service_role
-- (api/demo.js usa getSupabase = service_role). Nenhum cliente browser
-- acessa o Supabase diretamente para o demo. Policy idêntica às tabelas prod.

ALTER TABLE demo_cv_versions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_download_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_download_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_job_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_settings         ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role only" ON demo_cv_versions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role only" ON demo_download_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role only" ON demo_download_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role only" ON demo_job_applications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role only" ON demo_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
