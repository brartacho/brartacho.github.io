-- Backfill fit_score em candidaturas promovidas do Radar que ainda não têm o valor.
-- Copia o fit_score do vaga_radar para job_applications via origin_radar_id.
UPDATE job_applications ja
SET fit_score = vr.fit_score
FROM vaga_radar vr
WHERE ja.origin_radar_id = vr.id
  AND ja.fit_score IS NULL
  AND vr.fit_score IS NOT NULL;
