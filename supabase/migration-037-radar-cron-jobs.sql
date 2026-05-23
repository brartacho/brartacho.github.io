-- Fase 2: Agendamento automático das funções de limpeza do radar
-- Funções criadas na migration-036; aqui apenas os cron.schedule.
-- pg_cron v1.6.4 já está instalado no projeto.

-- Remove agendamentos anteriores e job legado (idempotente — sem erro se não existir)
DO $$
BEGIN
    -- Job legado que usava status 'arquivada' e auto_delete_discarded_days (obsoleto)
    PERFORM cron.unschedule('radar-lead-cleanup');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Remove agendamentos anteriores desta migration (idempotente)
DO $$
BEGIN
    PERFORM cron.unschedule('radar-expire-stale');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    PERFORM cron.unschedule('radar-purge-old-discarded');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    PERFORM cron.unschedule('radar-purge-old-promoted');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Diário às 03:00 UTC: expira leads novo/avaliada parados > 30 dias
-- (marca como descartada, não exclui — reversível via botão Restaurar)
SELECT cron.schedule(
    'radar-expire-stale',
    '0 3 * * *',
    'SELECT radar_expire_stale_leads()'
);

-- Dia 1 de cada mês às 04:00 UTC: exclui descartadas > 60 dias
-- (guarda por NOT EXISTS job_applications para evitar perda de histórico)
SELECT cron.schedule(
    'radar-purge-old-discarded',
    '0 4 1 * *',
    'SELECT radar_purge_old_discarded(60)'
);

-- Dia 1 de cada mês às 04:30 UTC: exclui promovidas > 180 dias
-- (só remove se não houver candidatura em_processo não-arquivada)
SELECT cron.schedule(
    'radar-purge-old-promoted',
    '30 4 1 * *',
    'SELECT radar_purge_old_promoted(180)'
);
