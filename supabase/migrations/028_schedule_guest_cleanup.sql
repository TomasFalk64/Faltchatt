-- Supabase supports pg_cron. Run this migration as postgres (SQL Editor/CLI).
create extension if not exists pg_cron;
select cron.schedule(
  'faltchatt-cleanup-guests',
  '0 * * * *',
  $$select private.cleanup_guests();$$
);
