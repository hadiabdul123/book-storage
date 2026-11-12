-- Keep mutation time separate from the server's upload/commit time.
alter table public.library_entries add column edited_at timestamptz;
alter table public.library_entries add column edit_id uuid not null default '00000000-0000-0000-0000-000000000000';
update public.library_entries set edited_at = updated_at;
alter table public.library_entries alter column edited_at set not null;
alter table public.library_entries alter column edited_at set default now();

create or replace function private.entry_json(e public.library_entries) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('key',e.kind||':'||e.id,'kind',e.kind,'id',e.id,'value',e.payload,
    'revision',e.revision,'deleted',e.deleted,'updatedAt',e.updated_at,
    'editedAt',e.edited_at,'editId',e.edit_id);
$$;

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
