-- migration-057: filtros opcionais por requisição na busca do radar
-- Adiciona coluna JSONB filters em search_requests para armazenar os filtros
-- aplicados na requisição (modalidade, tipo_contratacao, nivel, requires_cnh,
-- location, min_score). Ver bubbly-riding-whistle plan.

ALTER TABLE search_requests
  ADD COLUMN IF NOT EXISTS filters JSONB;
