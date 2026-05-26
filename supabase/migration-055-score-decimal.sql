-- Converte colunas de score de INTEGER para NUMERIC(3,1)
-- Permite valores como 7.3, 8.5 em vez de apenas inteiros.
-- Leads existentes são convertidos trivialmente (7 → 7.0, 5 → 5.0).
ALTER TABLE vaga_radar
  ALTER COLUMN fit_score         TYPE NUMERIC(3,1) USING fit_score::numeric(3,1),
  ALTER COLUMN fit_score_regras  TYPE NUMERIC(3,1) USING fit_score_regras::numeric(3,1),
  ALTER COLUMN fit_score_ia      TYPE NUMERIC(3,1) USING fit_score_ia::numeric(3,1),
  ALTER COLUMN reverse_fit_score TYPE NUMERIC(3,1) USING reverse_fit_score::numeric(3,1),
  ALTER COLUMN alignment_score   TYPE NUMERIC(3,1) USING alignment_score::numeric(3,1);
