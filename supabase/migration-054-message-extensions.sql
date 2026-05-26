-- migration-054: extensões ao bloco de mensagem de candidatura
-- Adiciona campos para histórico de versões e resetar para o original gerado pela IA

ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS application_message_original TEXT,
  ADD COLUMN IF NOT EXISTS application_message_history  JSONB NOT NULL DEFAULT '[]'::jsonb;
-- application_message_original: snapshot da primeira geração da IA (base para o botão "Resetar")
-- application_message_history:  [{ts, text, length, source: 'ia'|'manual', extra_instruction?}]
