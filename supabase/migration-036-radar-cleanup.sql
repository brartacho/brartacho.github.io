-- Limpeza otimizada do radar: índices + funções SQL para purge/expire.
-- Todas as funções respeitam a Camada 2 da defesa contra duplicatas:
-- nunca remove vaga_radar cujo link_vaga esteja em job_applications.

-- Índices para queries de limpeza
CREATE INDEX IF NOT EXISTS idx_vaga_radar_status_updated ON vaga_radar(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_job_applications_link_vaga ON job_applications(link_vaga);

-- Marca como descartada leads parados há >30 dias (sem app correspondente)
CREATE OR REPLACE FUNCTION radar_expire_stale_leads()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
    WITH updated AS (
        UPDATE vaga_radar r
        SET status = 'descartada',
            motivo_descarte = 'expirado: sem ação por 30 dias',
            updated_at = NOW()
        WHERE r.status IN ('novo', 'avaliada')
          AND r.updated_at < NOW() - INTERVAL '30 days'
          AND NOT EXISTS (
              SELECT 1 FROM job_applications a
              WHERE a.link_vaga = r.link_vaga AND a.link_vaga IS NOT NULL
          )
        RETURNING 1
    )
    SELECT COUNT(*) INTO n FROM updated;
    RETURN n;
END $$;

-- Purga descartadas antigas sem app correspondente (default: >60d)
CREATE OR REPLACE FUNCTION radar_purge_old_discarded(min_days integer DEFAULT 60)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
    WITH deleted AS (
        DELETE FROM vaga_radar r
        WHERE r.status = 'descartada'
          AND r.updated_at < NOW() - (min_days || ' days')::interval
          AND NOT EXISTS (
              SELECT 1 FROM job_applications a
              WHERE a.link_vaga = r.link_vaga AND a.link_vaga IS NOT NULL
          )
        RETURNING 1
    )
    SELECT COUNT(*) INTO n FROM deleted;
    RETURN n;
END $$;

-- Purga promovidas antigas sem app ativa (default: >180d)
CREATE OR REPLACE FUNCTION radar_purge_old_promoted(min_days integer DEFAULT 180)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
    WITH deleted AS (
        DELETE FROM vaga_radar r
        WHERE r.status = 'promovida'
          AND r.updated_at < NOW() - (min_days || ' days')::interval
          AND NOT EXISTS (
              SELECT 1 FROM job_applications a
              WHERE a.link_vaga = r.link_vaga
                AND a.link_vaga IS NOT NULL
                AND a.result = 'em_processo'
                AND a.archived = false
          )
        RETURNING 1
    )
    SELECT COUNT(*) INTO n FROM deleted;
    RETURN n;
END $$;
