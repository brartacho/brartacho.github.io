-- Corrige leads que foram promovidas individualmente antes do fix d7fc2da (27/05/2026),
-- quando o POST /api/admin/applications não atualizava vaga_radar.status para 'promovida'.
-- Essas leads têm origin_radar_id em job_applications mas status 'novo'/'avaliada' em vaga_radar.

UPDATE vaga_radar vr
SET
    status = 'promovida',
    promoted_application_id = (
        SELECT id FROM job_applications
        WHERE origin_radar_id = vr.id
        ORDER BY created_at ASC
        LIMIT 1
    ),
    updated_at = now()
FROM job_applications ja
WHERE ja.origin_radar_id = vr.id
  AND vr.status IN ('novo', 'avaliada');
