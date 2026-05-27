-- Adiciona coluna 'cidade' na tabela job_applications.
-- Permite registrar a cidade onde a vaga é baseada.
ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS cidade TEXT;
