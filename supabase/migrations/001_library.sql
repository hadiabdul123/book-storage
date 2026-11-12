-- Run once in a dedicated Supabase project's SQL editor.
create schema if not exists private;
create table private.owners (user_id uuid primary key references auth.users(id));
revoke all on schema private from public;
revoke all on all tables in schema private from public, anon, authenticated;

create function public.is_library_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from private.owners where user_id = auth.uid());
$$;
revoke all on function public.is_library_owner() from public, anon;
grant execute on function public.is_library_owner() to authenticated;

create table public.library_entries (
  owner_id uuid not null references auth.users(id),
  kind text not null check(kind in ('book','collection','membership','annotation','bookmark','position','session','preferences')),
  id text not null,
  payload jsonb not null,
  revision bigint not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key(owner_id,kind,id)
);
create index library_revision on public.library_entries(owner_id,revision);
create table private.sync_clock (owner_id uuid primary key references auth.users(id), revision bigint not null default 0);
create table private.sync_receipts (owner_id uuid not null, op_id uuid not null, result jsonb not null, primary key(owner_id,op_id));
alter table public.library_entries enable row level security;
create policy "Only the configured owner can read" on public.library_entries for select to authenticated
using (owner_id = (select auth.uid()) and (select public.is_library_owner()));
revoke all on public.library_entries from anon, authenticated;
grant select on public.library_entries to authenticated;

create function private.entry_json(e public.library_entries) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('key',e.kind||':'||e.id,'kind',e.kind,'id',e.id,'value',e.payload,
    'revision',e.revision,'deleted',e.deleted,'updatedAt',e.updated_at);
$$;

create function public.apply_change(p_operation jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  who uuid := auth.uid(); k text := p_operation->>'kind'; item text := p_operation->>'id';
  op uuid := (p_operation->>'opId')::uuid; body jsonb := p_operation->'value';
  base bigint := (p_operation->>'baseRevision')::bigint;
  gone boolean := coalesce((p_operation->>'deleted')::boolean,false);
  current_row public.library_entries; next_revision bigint; result jsonb;
  parent public.library_entries;
begin
  if who is null or not public.is_library_owner() then raise exception 'Owner access required' using errcode='42501'; end if;
  if k not in ('book','collection','membership','annotation','bookmark','position','session','preferences')
    or item is null or length(item)>100 or body->>'id' is distinct from item or base is null or base<0 then
    raise exception 'Invalid change';
  end if;
  -- Row lock serializes each owner's writes and keeps revision order consistent with commit order.
  insert into private.sync_clock(owner_id) values(who) on conflict do nothing;
  perform 1 from private.sync_clock where owner_id=who for update;
  select r.result into result from private.sync_receipts r where owner_id=who and op_id=op;
  if found then return result; end if;
  select * into current_row from public.library_entries where owner_id=who and kind=k and id=item;
  if coalesce(current_row.revision,0) <> base then
    return jsonb_build_object('conflict',true,'row',private.entry_json(current_row));
  end if;
  if k='book' then
    if current_row.payload->>'purgedAt' is not null and not gone then raise exception 'A permanently deleted book cannot be restored'; end if;
    if body->>'format' not in ('epub','pdf','docx') or body->>'hash' !~ '^[0-9a-f]{64}$'
      or body->>'sourcePath' is distinct from item||'/source.'||(body->>'format') then raise exception 'Invalid book'; end if;
    if current_row.id is not null and (body->>'hash' is distinct from current_row.payload->>'hash'
      or body->>'sourcePath' is distinct from current_row.payload->>'sourcePath') then raise exception 'Book content is immutable'; end if;
  end if;
  if k in ('annotation','bookmark','position','session','membership') and not gone then
    select * into parent from public.library_entries where owner_id=who and kind='book' and id=body->>'bookId' and not deleted;
    if not found then raise exception 'Book is missing or deleted'; end if;
    if k in ('annotation','bookmark','position') and body->'locator'->>'hash' is distinct from parent.payload->>'hash' then
      raise exception 'Location belongs to another document';
    end if;
    if k='membership' and not exists(select 1 from public.library_entries where owner_id=who and kind='collection' and id=body->>'collectionId' and not deleted) then
      raise exception 'Collection is missing'; end if;
  end if;
  update private.sync_clock set revision=revision+1 where owner_id=who returning revision into next_revision;
  insert into public.library_entries(owner_id,kind,id,payload,revision,deleted)
    values(who,k,item,body,next_revision,gone)
    on conflict(owner_id,kind,id) do update set payload=excluded.payload,revision=excluded.revision,deleted=excluded.deleted,updated_at=now()
    returning * into current_row;
  result:=jsonb_build_object('conflict',false,'row',private.entry_json(current_row));
  insert into private.sync_receipts values(who,op,result);
  return result;
end;
$$;

create function public.pull_changes(p_after bigint default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.is_library_owner() then raise exception 'Owner access required' using errcode='42501'; end if;
  select coalesce(jsonb_agg(private.entry_json(e) order by e.revision),'[]'::jsonb) into result
  from (select * from public.library_entries where owner_id=auth.uid() and revision>p_after order by revision limit 200) e;
  return result;
end;
$$;
revoke all on function public.apply_change(jsonb), public.pull_changes(bigint) from public, anon;
grant execute on function public.apply_change(jsonb), public.pull_changes(bigint) to authenticated;

insert into storage.buckets(id,name,public) values('library','library',false)
on conflict(id) do update set public=false;
create policy "Owner private files" on storage.objects for all to authenticated
using(bucket_id='library' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.is_library_owner()))
with check(bucket_id='library' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.is_library_owner()));


-- Explicit grants may be inherited from Supabase default privileges.
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
alter table private.owners enable row level security;
alter table private.sync_clock enable row level security;
alter table private.sync_receipts enable row level security;

-- Optional Realtime; periodic pulls remain authoritative.
do $$ begin
  alter publication supabase_realtime add table public.library_entries;
exception when duplicate_object then null;
end $$;

-- AFTER creating your user in Authentication > Users, run separately:
-- insert into private.owners(user_id) values ('YOUR_AUTH_USER_UUID');
-- Disable "Allow new users to sign up" in Authentication settings.
