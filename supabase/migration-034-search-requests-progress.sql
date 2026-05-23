-- Coluna progress para feedback de progresso em tempo real do MCP server
-- Frontend lê { current, done[], total, platforms[] } e renderiza barra + chips.
ALTER TABLE search_requests ADD COLUMN IF NOT EXISTS progress JSONB;
