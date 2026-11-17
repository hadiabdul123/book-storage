-- Additive entity kinds; the existing ownership and sync ordering contract is retained.
alter table public.library_entries drop constraint library_entries_kind_check;
alter table public.library_entries add constraint library_entries_kind_check check(kind in ('book','collection','membership','annotation','bookmark','position','session','preferences','notebook','notebook-section','notebook-note','ink-stroke','research-thread','research-message'));

create or replace function private.valid_note_node(n jsonb, depth integer default 0) returns boolean
language plpgsql immutable set search_path='' as $$
declare t text:=coalesce(n->>'type',''); child jsonb; mark jsonb; attrs jsonb:=n->'attrs'; allowed text[];
begin
  if jsonb_typeof(n) is distinct from 'object' or depth>30 or t not in ('doc','paragraph','text','heading','hardBreak','bulletList','orderedList','listItem','taskList','taskItem','citation','drawing') then return false; end if;
  if t='doc' and depth<>0 or depth=0 and t<>'doc' then return false; end if;
  if t='text' then
    if jsonb_typeof(n->'text') is distinct from 'string' or length(n->>'text') not between 1 and 100000 or n ? 'content' then return false; end if;
  elsif n ? 'text' or n ? 'marks' then return false;
  end if;
  if n ? 'marks' then
    if jsonb_typeof(n->'marks') is distinct from 'array' or jsonb_array_length(n->'marks')>12 then return false; end if;
    for mark in select value from jsonb_array_elements(n->'marks') loop
      if coalesce(mark->>'type','') in ('bold','italic','underline') then
        if mark ? 'attrs' then return false; end if;
      elsif mark->>'type' in ('highlight','textStyle') then
        if jsonb_typeof(mark->'attrs') is distinct from 'object' or coalesce(mark->'attrs'->>'color','') !~* '^(#[a-f0-9]{6}|rgb\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*\))$' or exists(select 1 from jsonb_object_keys(mark->'attrs') k where k<>'color') then return false; end if;
      elsif mark->>'type'='link' then
        if jsonb_typeof(mark->'attrs') is distinct from 'object' or coalesce(mark->'attrs'->>'href','') !~* '^(https?://|mailto:)[^[:space:]]+$' or length(mark->'attrs'->>'href')>4000 or exists(select 1 from jsonb_object_keys(mark->'attrs') k where k not in ('href','target','rel','class')) or mark->'attrs'->>'class' is not null or coalesce(mark->'attrs'->>'target','_blank') not in ('_blank','_self') then return false; end if;
      else return false;
      end if;
    end loop;
  end if;
  if t='citation' then return jsonb_typeof(attrs->'source')='object' and coalesce(attrs->'source'->>'kind','') in ('book','note','web') and not n ? 'content'; end if;
  if t='drawing' then
    if jsonb_typeof(attrs) is distinct from 'object' or coalesce(attrs->>'blockId','') !~ '^[a-zA-Z0-9-]{1,100}$' or jsonb_typeof(attrs->'height') is distinct from 'number' then return false; end if;
    return (attrs->>'height')::numeric between 140 and 800 and not n ? 'content' and not exists(select 1 from jsonb_object_keys(attrs) k where k not in ('blockId','height'));
  end if;
  if attrs is not null then
    if jsonb_typeof(attrs) is distinct from 'object' then return false; end if;
    if exists(select 1 from jsonb_object_keys(attrs) k where not ((t='heading' and k='level') or (t='orderedList' and k in ('start','type')) or (t='taskItem' and k='checked'))) then return false; end if;
    if t='heading' and coalesce(attrs->>'level','') not in ('1','2','3') then return false; end if;
    if t='taskItem' and jsonb_typeof(attrs->'checked') is distinct from 'boolean' then return false; end if;
    if t='orderedList' then
      if jsonb_typeof(attrs->'start') is distinct from 'number' then return false; end if;
      if (attrs->>'start')::numeric<1 or trunc((attrs->>'start')::numeric)<>(attrs->>'start')::numeric then return false; end if;
    end if;
  end if;
  allowed:=case t when 'doc' then array['paragraph','heading','bulletList','orderedList','taskList','citation','drawing'] when 'paragraph' then array['text','hardBreak'] when 'heading' then array['text','hardBreak'] when 'bulletList' then array['listItem'] when 'orderedList' then array['listItem'] when 'taskList' then array['taskItem'] when 'listItem' then array['paragraph','heading','bulletList','orderedList','taskList'] when 'taskItem' then array['paragraph','heading','bulletList','orderedList','taskList'] else array[]::text[] end;
  if n ? 'content' then
    if jsonb_typeof(n->'content') is distinct from 'array' or jsonb_array_length(n->'content')>10000 then return false; end if;
    for child in select value from jsonb_array_elements(n->'content') loop
      if not coalesce(child->>'type'=any(allowed),false) or not private.valid_note_node(child,depth+1) then return false; end if;
    end loop;
  end if;
  return true;
exception when others then return false;
end;
$$;

create or replace function private.valid_ink_stroke(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare p jsonb; target jsonb:=v->'target'; stamp timestamptz;
begin
  if length(v::text)>700000 or jsonb_typeof(v->'createdAt') is distinct from 'string' or coalesce(v->>'tool','') not in ('pen','highlighter') or coalesce(v->>'color','') !~* '^#[a-f0-9]{6}$' or jsonb_typeof(v->'width') is distinct from 'number' or jsonb_typeof(v->'points') is distinct from 'array' then return false; end if;
  stamp:=(v->>'createdAt')::timestamptz;
  if not isfinite(stamp) or (v->>'width')::numeric<=0 or (v->>'width')::numeric>40 or jsonb_array_length(v->'points') not between 1 and 10000 then return false; end if;
  for p in select value from jsonb_array_elements(v->'points') loop
    if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p)<>3 or jsonb_typeof(p->0) is distinct from 'number' or jsonb_typeof(p->1) is distinct from 'number' or jsonb_typeof(p->2) is distinct from 'number' then return false; end if;
    if abs((p->>0)::numeric)>100000 or abs((p->>1)::numeric)>100000 or (p->>2)::numeric not between 0 and 1 then return false; end if;
  end loop;
  if target->>'type'='pdf' then return length(target->>'bookId') between 1 and 100 and coalesce(target->>'hash','') ~ '^[a-f0-9]{64}$' and jsonb_typeof(target->'page')='number' and (target->>'page')::numeric between 1 and 100000 and trunc((target->>'page')::numeric)=(target->>'page')::numeric;
  elsif target->>'type'='notebook' then return length(target->>'noteId') between 1 and 100 and coalesce(target->>'blockId','') ~ '^[a-zA-Z0-9-]{1,100}$';
  end if;
  return false;
exception when others then return false;
end;
$$;
revoke all on function private.valid_note_node(jsonb,integer) from public, anon, authenticated;
revoke all on function private.valid_ink_stroke(jsonb) from public, anon, authenticated;

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
  if k not in ('book','collection','membership','annotation','bookmark','position','session','preferences','notebook','notebook-section','notebook-note','ink-stroke','research-thread','research-message')
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

  if k='notebook-section' and not gone then
    if length(body::text)>10000 or jsonb_typeof(body->'title') is distinct from 'string' or length(body->>'title') not between 1 and 200
      or jsonb_typeof(body->'order') is distinct from 'number' or jsonb_typeof(body->'createdAt') is distinct from 'string' then raise exception 'Invalid section'; end if;
    perform (body->>'createdAt')::timestamptz;
    if not exists(select 1 from public.library_entries where owner_id=who and kind='notebook' and id=body->>'notebookId' and not deleted) then raise exception 'Notebook is missing'; end if;
  end if;
  if k='notebook-note' and not gone then
    if private.valid_note_node(body->'document') is distinct from true then raise exception 'Invalid notebook formatting'; end if;
    if body->>'sectionId' is not null and not exists(select 1 from public.library_entries where owner_id=who and kind='notebook-section' and id=body->>'sectionId' and payload->>'notebookId'=body->>'notebookId' and not deleted) then raise exception 'Section is missing'; end if;
    if body ? 'order' and jsonb_typeof(body->'order') is distinct from 'number' then raise exception 'Invalid page order'; end if;
  end if;
  if k='annotation' and not gone and body->>'type'='page-note' and private.valid_note_node(body->'content'->'document') is distinct from true then raise exception 'Invalid page note formatting'; end if;
  if k='ink-stroke' and not gone then
    if private.valid_ink_stroke(body) is distinct from true then raise exception 'Invalid drawing'; end if;
    if current_row.id is not null and current_row.payload->'target' is distinct from body->'target' then raise exception 'Drawing target is immutable'; end if;
    if body->'target'->>'type'='pdf' then
      if not exists(select 1 from public.library_entries where owner_id=who and kind='book' and id=body->'target'->>'bookId' and not deleted and payload->>'format'='pdf' and payload->>'hash'=body->'target'->>'hash') then raise exception 'Drawing book is missing or belongs to another edition'; end if;
    else
      if not exists(select 1 from public.library_entries n join public.library_entries b on b.owner_id=n.owner_id and b.kind='notebook' and b.id=n.payload->>'notebookId' and not b.deleted where n.owner_id=who and n.kind='notebook-note' and n.id=body->'target'->>'noteId' and not n.deleted) then raise exception 'Drawing notebook page is missing'; end if;
    end if;
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


revoke all on function public.apply_change(jsonb) from public, anon;
grant execute on function public.apply_change(jsonb) to authenticated;
