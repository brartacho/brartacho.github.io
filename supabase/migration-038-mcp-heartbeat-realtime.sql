-- Heartbeat do MCP server: frontend lê para detectar se o servidor está online.
-- Atualizado a cada 15s pelo servidor; frontend considera online se < 45s atrás.
ALTER TABLE candidate_profile
    ADD COLUMN IF NOT EXISTS mcp_heartbeat_at TIMESTAMPTZ;

-- Habilita Realtime na tabela search_requests para que o MCP server receba
-- notificação imediata de INSERT (latência <1s, vs 20s do polling anterior).
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE search_requests;
EXCEPTION WHEN duplicate_object THEN
    NULL; -- já está na publicação
END $$;
