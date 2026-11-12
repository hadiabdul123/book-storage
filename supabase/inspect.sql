-- Read-only preflight in the existing project's SQL editor before initialization.
select to_regclass('public.library_entries') as library_table,
  to_regclass('private.owners') as owner_allowlist,
  to_regprocedure('public.is_library_owner()') as owner_check,
  to_regprocedure('public.apply_change(jsonb)') as write_rpc,
  to_regprocedure('public.pull_changes(bigint)') as read_rpc;
select id, public, file_size_limit from storage.buckets where id='library';
select schemaname, tablename, policyname, roles, cmd, qual, with_check
  from pg_policies where (schemaname='public' and tablename='library_entries')
  or (schemaname='storage' and tablename='objects');
-- Account identifiers only: never select password hashes or authentication tokens.
select id, email, email_confirmed_at from auth.users order by created_at;
