-- Additive: existing books, annotations, synchronization ordering and policies stay intact.
alter table public.library_entries drop constraint library_entries_kind_check;
alter table public.library_entries add constraint library_entries_kind_check check(kind in ('book','collection','membership','annotation','bookmark','position','session','preferences','notebook','notebook-note','research-thread','research-message'));

create or replace function public.apply_change(p_operation jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  who uuid := auth.uid(); k text := p_operation->>'kind'; item text := p_operation->>'id';
  op uuid := (p_operation->>'opId')::uuid; body jsonb := p_operation->'value';
  base bigint := (p_operation->>'baseRevision')::bigint;
  gone boolean := coalesce((p_operation->>'deleted')::boolean,false);
  current_row public.library_entries; next_revision bigint; result jsonb;
  parent public.library_entries;
  edited timestamptz := (p_operation->>'createdAt')::timestamptz;
begin
  if who is null or not public.is_library_owner() then raise exception 'Owner access required' using errcode='42501'; end if;
  if k not in ('book','collection','membership','annotation','bookmark','position','session','preferences','notebook','notebook-note','research-thread','research-message')
    or item is null or length(item)>100 or body->>'id' is distinct from item or base is null or base<0 then
    raise exception 'Invalid change';
  end if;
  -- Row lock serializes each owner's writes and keeps revision order consistent with commit order.
  insert into private.sync_clock(owner_id) values(who) on conflict do nothing;
  perform 1 from private.sync_clock where owner_id=who for update;
  select r.result into result from private.sync_receipts r where owner_id=who and op_id=op;
  if found then return result; end if;
  select * into current_row from public.library_entries where owner_id=who and kind=k and id=item;
  -- Timestamp-less legacy integrations retain their existing revision contract.
  if edited is null and coalesce(current_row.revision,0) <> base then
    return jsonb_build_object('conflict',true,'row',private.entry_json(current_row));
  end if;
  edited := coalesce(edited, clock_timestamp());
  if not isfinite(edited) then raise exception 'Invalid edit time'; end if;
  -- Arrival order is irrelevant: delayed offline edits must not revive a newer deletion.
  -- A deterministic tie uses deletion first, then the operation UUID.
  if current_row.id is not null and
    (edited, gone, op) <= (current_row.edited_at, current_row.deleted, current_row.edit_id) then
    result := jsonb_build_object('conflict',false,'superseded',true,'row',private.entry_json(current_row));
    insert into private.sync_receipts values(who,op,result);
    return result;
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
  if k in ('notebook','notebook-note','research-thread','research-message') and not gone then
    if length(body::text)>500000 or jsonb_typeof(body->'createdAt') is distinct from 'string' then raise exception 'Invalid research record'; end if;
    perform (body->>'createdAt')::timestamptz;
    if k in ('notebook','notebook-note','research-thread') and
      (jsonb_typeof(body->'title') is distinct from 'string' or length(body->>'title') not between 1 and 200) then raise exception 'Invalid title'; end if;
    if k='notebook-note' then
      if jsonb_typeof(body->'document') is distinct from 'object' or body->'document'->>'type' is distinct from 'doc'
        or jsonb_typeof(body->'tags') is distinct from 'array' then raise exception 'Invalid notebook document'; end if;
      perform (body->>'updatedAt')::timestamptz;
      if not exists(select 1 from public.library_entries where owner_id=who and kind='notebook' and id=body->>'notebookId' and not deleted) then raise exception 'Notebook is missing'; end if;
    end if;
    if k='research-thread' then
      if body->>'notebookId' is not null and not exists(select 1 from public.library_entries where owner_id=who and kind='notebook' and id=body->>'notebookId' and not deleted) then raise exception 'Notebook is missing'; end if;
      if body->>'bookId' is not null and not exists(select 1 from public.library_entries where owner_id=who and kind='book' and id=body->>'bookId' and not deleted) then raise exception 'Book is missing'; end if;
    end if;
    if k='research-message' then
      if not exists(select 1 from public.library_entries where owner_id=who and kind='research-thread' and id=body->>'threadId' and not deleted) then raise exception 'Conversation is missing'; end if;
      if jsonb_typeof(body->'question') is distinct from 'string' or length(body->>'question')>1500
        or jsonb_typeof(body->'answer') is distinct from 'string' or length(body->>'answer')>12000
        or body->>'mode' not in ('explain','sources','web') or jsonb_typeof(body->'sources') is distinct from 'array'
        or jsonb_array_length(body->'sources')>20 then raise exception 'Invalid research answer'; end if;
    end if;
  end if;
  update private.sync_clock set revision=revision+1 where owner_id=who returning revision into next_revision;
  insert into public.library_entries(owner_id,kind,id,payload,revision,deleted,edited_at,edit_id)
    values(who,k,item,body,next_revision,gone,edited,op)
    on conflict(owner_id,kind,id) do update set payload=excluded.payload,revision=excluded.revision,
      deleted=excluded.deleted,updated_at=now(),edited_at=excluded.edited_at,edit_id=excluded.edit_id
    returning * into current_row;
  result:=jsonb_build_object('conflict',false,'row',private.entry_json(current_row));
  insert into private.sync_receipts values(who,op,result);
  return result;
end;
$$;

revoke all on function private.entry_json(public.library_entries) from public, anon, authenticated;
revoke all on function public.apply_change(jsonb) from public, anon;
grant execute on function public.apply_change(jsonb) to authenticated;

-- Durable request replay and free-allowance guards. No prompts or API keys.
create table private.research_requests (
  owner_id uuid not null references auth.users(id),
  id uuid not null,
  started_at timestamptz not null default now(),
  result jsonb,
  state text not null default 'pending' check(state in ('pending','done','failed')),
  primary key(owner_id,id)
);
create table private.research_attempts (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id),
  mode text not null check(mode in ('explain','sources','web')),
  created_at timestamptz not null default now()
);
create index research_attempt_time on private.research_attempts(owner_id,created_at);
alter table private.research_requests enable row level security;
alter table private.research_attempts enable row level security;
revoke all on private.research_requests,private.research_attempts from public,anon,authenticated;

create function public.research_begin(p_id uuid,p_mode text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare who uuid:=auth.uid(); prior private.research_requests;
begin
  if who is null or not public.is_library_owner() then raise exception 'Owner access required' using errcode='42501'; end if;
  if p_id is null or p_mode is null or p_mode not in ('explain','sources','web') then raise exception 'Invalid research request'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(who::text,92));
  select * into prior from private.research_requests where owner_id=who and id=p_id;
  if found and prior.state='done' then return jsonb_build_object('state','cached','result',prior.result); end if;
  if found and prior.state='pending' and prior.started_at>now()-interval '70 seconds' then return jsonb_build_object('state','busy'); end if;
  if (select count(*) from private.research_attempts where owner_id=who and created_at>now()-interval '10 minutes')>=20
    or (p_mode='web' and (select count(*) from private.research_attempts where owner_id=who and mode='web' and created_at>=date_trunc('month',now()))>=900) then
    return jsonb_build_object('state','limited');
  end if;
  insert into private.research_attempts(owner_id,mode) values(who,p_mode);
  insert into private.research_requests(owner_id,id) values(who,p_id)
    on conflict(owner_id,id) do update set started_at=now(),state='pending',result=null;
  delete from private.research_attempts where owner_id=who and created_at<now()-interval '90 days';
  delete from private.research_requests where owner_id=who and started_at<now()-interval '30 days';
  return jsonb_build_object('state','new');
end;
$$;
create function public.research_finish(p_id uuid,p_result jsonb default null) returns void
language plpgsql security definer set search_path='' as $$
declare who uuid:=auth.uid();
begin
  if who is null or not public.is_library_owner() then raise exception 'Owner access required' using errcode='42501'; end if;
  if p_result is not null and (length(p_result::text)>100000 or jsonb_typeof(p_result->'answer') is distinct from 'string' or jsonb_typeof(p_result->'sources') is distinct from 'array') then raise exception 'Invalid research result'; end if;
  update private.research_requests set result=p_result,state=case when p_result is null then 'failed' else 'done' end
    where owner_id=who and id=p_id and state='pending';
end;
$$;
revoke all on function public.research_begin(uuid,text),public.research_finish(uuid,jsonb) from public,anon;
grant execute on function public.research_begin(uuid,text),public.research_finish(uuid,jsonb) to authenticated;
