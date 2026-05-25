-- migration-053: re-inferir modalidade de leads com fonte=linkedin
-- Corrige leads onde modalidade estava incorreta por bug no normalizer
-- (hibrida não era reconhecida, descrição era usada como fallback → falsos positivos)

UPDATE vaga_leads
SET modalidade = CASE
    -- Híbrida: detectar variações com e sem acento
    WHEN lower(unaccent(localizacao)) LIKE '%hibrido%'
      OR lower(unaccent(localizacao)) LIKE '%hibrida%'
      OR lower(localizacao)           LIKE '%hybrid%'
    THEN 'Híbrida'

    -- Remota
    WHEN lower(unaccent(localizacao)) LIKE '%remoto%'
      OR lower(unaccent(localizacao)) LIKE '%remota%'
      OR lower(localizacao)           LIKE '%remote%'
      OR lower(localizacao)           LIKE '%home office%'
    THEN 'Remota'

    -- Presencial
    WHEN lower(unaccent(localizacao)) LIKE '%presencial%'
      OR lower(localizacao)           LIKE '%on-site%'
      OR lower(localizacao)           LIKE '%onsite%'
    THEN 'Presencial'

    -- Sem localização confiável: zera para re-scraping manual
    ELSE NULL
END
WHERE fonte = 'linkedin'
  AND localizacao IS NOT NULL
  AND localizacao != '';

-- Leads sem localizacao mas com modalidade incorreta via descrição: zera
UPDATE vaga_leads
SET modalidade = NULL
WHERE fonte = 'linkedin'
  AND (localizacao IS NULL OR localizacao = '')
  AND modalidade IS NOT NULL;
