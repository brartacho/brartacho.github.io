-- Adiciona coluna 'error_note' na tabela search_log.
-- Permite registrar erros de scrapers (ex: chave API ausente) na linha
-- de histórico, tornando o problema visível no painel "últimas execuções".
ALTER TABLE search_log
  ADD COLUMN IF NOT EXISTS error_note TEXT;
