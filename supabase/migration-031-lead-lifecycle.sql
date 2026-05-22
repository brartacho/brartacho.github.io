-- ============================================================
-- Migration 031 — Ciclo de vida dos leads: pg_cron auto-limpeza
-- Aplicar no SQL Editor do Supabase (projeto kbtbvcqlqwzgfduxtuwr)
-- Nota: auto_delete_discarded_days e auto_delete_stale_days foram adicionados
--       na migration 028. Esta migration apenas configura o pg_cron.
-- ============================================================

-- Job pg_cron: roda às 3h diariamente
-- Se der erro no cron.schedule, pg_cron pode não estar ativado — não é bloqueador.
-- Ativar em: Dashboard → Database → Extensions → pg_cron
SELECT cron.schedule(
  'radar-lead-cleanup',
  '0 3 * * *',
  $$
    DELETE FROM vaga_radar
    WHERE status = 'descartada'
      AND updated_at < NOW() - (
        (SELECT auto_delete_discarded_days FROM candidate_profile ORDER BY updated_at DESC LIMIT 1)
        || ' days'
      )::interval;

    UPDATE vaga_radar
    SET status = 'arquivada', updated_at = NOW()
    WHERE status IN ('novo', 'avaliada')
      AND updated_at < NOW() - (
        (SELECT auto_delete_stale_days FROM candidate_profile ORDER BY updated_at DESC LIMIT 1)
        || ' days'
      )::interval;
  $$
);
