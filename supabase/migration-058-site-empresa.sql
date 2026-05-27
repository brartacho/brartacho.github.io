-- Adiciona coluna 'site_empresa' na tabela job_applications.
-- Armazena a URL do site da empresa para acesso rápido na candidatura.
ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS site_empresa TEXT;
