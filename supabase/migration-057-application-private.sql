-- Adiciona coluna 'private' (modo stealth) na tabela job_applications.
-- Candidaturas privadas são ocultadas da lista principal e visíveis
-- apenas com o filtro "privadas" ativo.
ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS private BOOLEAN NOT NULL DEFAULT FALSE;
