alter table public.library_entries drop constraint library_entries_kind_check;
alter table public.library_entries add constraint library_entries_kind_check check(kind in ('book','collection','membership','annotation','highlight-study','highlight-followup','bookmark','position','session','preferences','notebook','notebook-section','notebook-note','ink-stroke','pdf-text-box','quote-category','card-filing','highlight-view','research-card','notebook-overlay','notebook-media','notebook-image','research-thread','research-message'));

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
  if k not in ('book','collection','membership','annotation','highlight-study','highlight-followup','bookmark','position','session','preferences','notebook','notebook-section','notebook-note','ink-stroke','pdf-text-box','quote-category','card-filing','highlight-view','research-card','notebook-overlay','notebook-media','notebook-image','research-thread','research-message')
    or item is null or length(item)>(case when k='card-filing' then 201 else 100 end) or body->>'id' is distinct from item or base is null or base<0 then
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
  if k='highlight-view' and (jsonb_typeof(body->'name') is distinct from 'string' or length(btrim(body->>'name')) not between 1 and 80
    or jsonb_typeof(body->'filters') is distinct from 'object' or length(body::text)>24000) then
    raise exception 'Invalid highlight view';
  end if;
  if k='highlight-view' and exists (select 1 from jsonb_each(body->'filters') e where e.key not in ('q','book','category','tag','notebook','color','type','priority','sort','groupSort') or jsonb_typeof(e.value)<>'string') then
    raise exception 'Invalid highlight filters';
  end if;
  if k='card-filing' and (body ? 'x' or body ? 'y') and (not coalesce(private.study_number(body->'x',-1000000,1000000),false) or not coalesce(private.study_number(body->'y',-1000000,1000000),false)) then
    raise exception 'Invalid card position';
  end if;
  if k='quote-category' and (jsonb_typeof(body->'name') is distinct from 'string' or length(btrim(body->>'name')) not between 1 and 80) then
    raise exception 'Invalid category';
  end if;
  if k='card-filing' and (item is distinct from (body->>'categoryId')||':'||(body->>'cardId') or length(body::text)>1024) then
    raise exception 'Invalid card filing';
  end if;
  if k='card-filing' and not gone and (
    not exists(select 1 from public.library_entries where owner_id=who and kind='quote-category' and id=body->>'categoryId')
    or not exists(select 1 from public.library_entries where owner_id=who and kind in ('annotation','research-card') and id=body->>'cardId')
  ) then raise exception 'Card or category is missing'; end if;
  if k='research-card' and (coalesce(body->>'kind','') not in ('quote','finding') or jsonb_typeof(body->'text') is distinct from 'string'
    or length(btrim(body->>'text')) not between 1 and 20000 or jsonb_typeof(body->'sources') is distinct from 'array'
    or length(body::text)>250000) then raise exception 'Invalid research card'; end if;
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

  if k in ('highlight-study','highlight-followup') then
    if length(body::text)>100000 or item='' then raise exception 'Invalid highlight study record'; end if;
    if k='highlight-study' then
      if jsonb_typeof(body->'priority') is distinct from 'string'
        or body->>'priority' not in ('important','lower') then raise exception 'Invalid highlight priority'; end if;
      select * into parent from public.library_entries where owner_id=who and kind='annotation' and id=item;
    else
      if jsonb_typeof(body->'annotationId') is distinct from 'string' or length(body->>'annotationId') not between 1 and 100
        or jsonb_typeof(body->'text') is distinct from 'string' or length(body->>'text')>12000 or btrim(body->>'text')=''
        or jsonb_typeof(body->'createdAt') is distinct from 'string' or not isfinite((body->>'createdAt')::timestamptz)
        then raise exception 'Invalid highlight follow-up'; end if;
      if current_row.id is not null and current_row.payload->>'annotationId' is distinct from body->>'annotationId'
        then raise exception 'Highlight parent is immutable'; end if;
      select * into parent from public.library_entries where owner_id=who and kind='annotation' and id=body->>'annotationId';
    end if;
    -- Delayed offline edits stay associated with the same highlight in Trash.
    if not found or parent.payload->>'type'='page-note' then raise exception 'Highlight is missing'; end if;
  end if;

  if k in ('notebook-media','notebook-image','notebook-overlay') then
    if length(body::text)>4096 or item !~ '^[a-zA-Z0-9-]{1,100}$'
      or coalesce(body->>'noteId','') !~ '^[a-zA-Z0-9-]{1,100}$'
      or jsonb_typeof(body->'createdAt') is distinct from 'string'
      or not isfinite((body->>'createdAt')::timestamptz) then raise exception 'Invalid notebook asset'; end if;
    if current_row.id is not null and current_row.payload->>'noteId' is distinct from body->>'noteId'
      then raise exception 'Notebook asset parent is immutable'; end if;
    if not gone and not exists(
      select 1 from public.library_entries n join public.library_entries b
        on b.owner_id=n.owner_id and b.kind='notebook' and b.id=n.payload->>'notebookId' and not b.deleted
      where n.owner_id=who and n.kind='notebook-note' and n.id=body->>'noteId' and not n.deleted
    ) then raise exception 'Notebook page is missing'; end if;
    if k='notebook-overlay' then
      if coalesce(body->>'anchor','') !~ '^[a-zA-Z0-9-]{1,100}$'
        or jsonb_typeof(body->'x') is distinct from 'number'
        or jsonb_typeof(body->'y') is distinct from 'number'
        or jsonb_typeof(body->'scale') is distinct from 'number'
        or abs((body->>'x')::numeric)>100000 or abs((body->>'y')::numeric)>100000
        or (body->>'scale')::numeric not between 0.1 and 10 then raise exception 'Invalid drawing placement'; end if;
    else
      if (k='notebook-media' and coalesce(body->>'extension','') not in ('mp4','webm','mp3','m4a','wav','ogg'))
        or (k='notebook-image' and coalesce(body->>'extension','') not in ('png','jpg','jpeg','webp','gif'))
        or coalesce(body->>'hash','') !~ '^[a-f0-9]{64}$'
        or jsonb_typeof(body->'title') is distinct from 'string'
        or length(btrim(body->>'title')) not between 1 and 200
        or jsonb_typeof(body->'size') is distinct from 'number'
        or (body->>'size')::numeric not between 1 and 52428800
        or (body->>'size')::numeric <> trunc((body->>'size')::numeric) then raise exception 'Invalid attachment'; end if;
      if current_row.payload ? 'placement' and not body ? 'placement' then
        body := body || jsonb_build_object('placement', current_row.payload->'placement');
      end if;
      if body ? 'placement' and (jsonb_typeof(body->'placement') is distinct from 'object'
        or jsonb_typeof(body->'placement'->'after') is distinct from 'string'
        or coalesce(body->'placement'->>'after','') !~ '^[a-zA-Z0-9-]{1,100}$'
        or jsonb_typeof(body->'placement'->'order') is distinct from 'number'
        or (body->'placement'->>'order')::numeric not between 0 and 9007199254740991
        or (body->'placement'->>'order')::numeric <> trunc((body->'placement'->>'order')::numeric))
        then raise exception 'Invalid attachment placement'; end if;
      if current_row.id is not null and (current_row.payload->>'extension' is distinct from body->>'extension'
        or current_row.payload->>'size' is distinct from body->>'size' or current_row.payload->>'hash' is distinct from body->>'hash') then raise exception 'Original attachment is immutable'; end if;
      if current_row.payload->>'purgedAt' is not null and (not gone or body->>'purgedAt' is null)
        then raise exception 'A permanently deleted attachment cannot be restored'; end if;
      if body->>'purgedAt' is not null and (not gone or not isfinite((body->>'purgedAt')::timestamptz))
        then raise exception 'Invalid attachment deletion'; end if;
      if not gone and not exists(select 1 from storage.objects where bucket_id='notebook-media'
        and name=who::text||'/'||(body->>'noteId')||'/'||item||'.'||(body->>'extension')
        and metadata->>'size'=body->>'size') then raise exception 'Upload the original attachment first'; end if;
    end if;
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
  if k='pdf-text-box' then
    if current_row.id is not null and
      (current_row.payload->'bookId', current_row.payload->'hash', current_row.payload->'page') is distinct from
      (body->'bookId', body->'hash', body->'page') then raise exception 'Text box page and edition are immutable'; end if;
    if not gone then
      if private.valid_pdf_text_box(body) is distinct from true then raise exception 'Invalid PDF text box'; end if;
      if not exists(select 1 from public.library_entries where owner_id=who and kind='book' and id=body->>'bookId'
        and not deleted and payload->>'format'='pdf' and payload->>'hash'=body->>'hash')
        then raise exception 'Text box book is missing or belongs to another edition'; end if;
    elsif current_row.id is null then
      raise exception 'Text box is missing';
    end if;
  end if;
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
