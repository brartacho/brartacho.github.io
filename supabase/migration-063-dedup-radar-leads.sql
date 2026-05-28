-- Remove leads duplicadas no radar que compartilham o mesmo link_vaga,
-- mantendo apenas o registro mais antigo (menor created_at).
-- Leads sem link_vaga não são afetadas por esta migration.

DELETE FROM vaga_radar
WHERE id IN (
    SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY link_vaga
                   ORDER BY created_at ASC
               ) AS rn
        FROM vaga_radar
        WHERE link_vaga IS NOT NULL
    ) ranked
    WHERE rn > 1
);
