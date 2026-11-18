-- Accept bounded notebook sizing while retaining existing rich documents.
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
      elsif mark->>'type'='highlight' then
        if jsonb_typeof(mark->'attrs') is distinct from 'object' or coalesce(mark->'attrs'->>'color','') !~* '^(#[a-f0-9]{6}|rgb\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*\))$' or exists(select 1 from jsonb_object_keys(mark->'attrs') k where k<>'color') then return false; end if;
      elsif mark->>'type'='textStyle' then
        if jsonb_typeof(mark->'attrs') is distinct from 'object'
          or exists(select 1 from jsonb_object_keys(mark->'attrs') k where k not in ('color','fontSize'))
          or (mark->'attrs'->>'color' is null and mark->'attrs'->>'fontSize' is null)
          or (mark->'attrs'->>'color' is not null and (jsonb_typeof(mark->'attrs'->'color') <> 'string'
            or mark->'attrs'->>'color' !~* '^(#[a-f0-9]{6}|rgb\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*\))$'))
          or (mark->'attrs'->>'fontSize' is not null and (jsonb_typeof(mark->'attrs'->'fontSize') <> 'string'
            or mark->'attrs'->>'fontSize' !~ '^(1[0-9]|[2-5][0-9]|6[0-4])px$')) then return false; end if;
      elsif mark->>'type'='link' then
        if jsonb_typeof(mark->'attrs') is distinct from 'object' or coalesce(mark->'attrs'->>'href','') !~* '^(https?://|mailto:)[^[:space:]]+$' or length(mark->'attrs'->>'href')>4000 or exists(select 1 from jsonb_object_keys(mark->'attrs') k where k not in ('href','target','rel','class','title')) or mark->'attrs'->>'class' is not null
          or (mark->'attrs'->>'title' is not null and (jsonb_typeof(mark->'attrs'->'title') <> 'string' or length(mark->'attrs'->>'title')>200)) or coalesce(mark->'attrs'->>'target','_blank') not in ('_blank','_self') then return false; end if;
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
    if exists(select 1 from jsonb_object_keys(attrs) k where not (((t in ('paragraph','heading') and k='inkAnchor') or (t='heading' and k='level')) or (t='orderedList' and k in ('start','type')) or (t='taskItem' and k='checked'))) then return false; end if;
    if attrs ? 'inkAnchor' and jsonb_typeof(attrs->'inkAnchor') <> 'null'
      and (jsonb_typeof(attrs->'inkAnchor') <> 'string' or attrs->>'inkAnchor' !~ '^[a-zA-Z0-9-]{1,100}$') then return false; end if;
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

revoke all on function private.valid_note_node(jsonb,integer) from public, anon, authenticated;

create or replace function private.study_number(v jsonb, lo numeric, hi numeric, whole boolean default false)
returns boolean language sql immutable set search_path='' as $$
  select case when jsonb_typeof(v)='number' then
    (v #>> '{}')::numeric between lo and hi and
    (not whole or trunc((v #>> '{}')::numeric)=(v #>> '{}')::numeric)
  else false end
$$;

create or replace function private.study_citations(ids jsonb, sources jsonb, books jsonb, only_book text default null)
returns boolean language plpgsql immutable set search_path='' as $$
begin
  if jsonb_typeof(ids) is distinct from 'array' or jsonb_typeof(sources) is distinct from 'array' then return false; end if;
  return jsonb_array_length(ids)<=7
    and (select count(distinct ref) from jsonb_array_elements(ids) as r(ref))=jsonb_array_length(ids)
    and not exists(
      select 1 from jsonb_array_elements(ids) as r(ref)
      where jsonb_typeof(ref)<>'string' or not exists(
        select 1 from jsonb_array_elements(sources) as s(src)
        where src->'id'=ref and src->>'kind'='book' and
          case when only_book is not null then src->>'bookId'=only_book else exists(
            select 1 from jsonb_array_elements(books) as b(book) where book->>'bookId'=src->>'bookId'
          ) end
      )
    );
end
$$;

create or replace function private.valid_study_comparison(v jsonb, sources jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare col jsonb; columns jsonb:=v->'columns'; synthesis jsonb:=v->'synthesis'; has_answer boolean:=false;
begin
  if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(columns) is distinct from 'array'
    or jsonb_typeof(synthesis) is distinct from 'object' then return false; end if;
  if jsonb_array_length(columns) not between 2 and 4
    or (select count(distinct c->>'bookId') from jsonb_array_elements(columns) as e(c))<>jsonb_array_length(columns)
    then return false; end if;
  for col in select value from jsonb_array_elements(columns) loop
    if jsonb_typeof(col->'bookId') is distinct from 'string' or col->>'bookId' !~ '^[a-zA-Z0-9:-]{1,120}$'
      or jsonb_typeof(col->'title') is distinct from 'string' or length(btrim(col->>'title')) not between 1 and 300
      or jsonb_typeof(col->'answer') is distinct from 'string' or length(col->>'answer')>1200
      or jsonb_typeof(col->'gap') is distinct from 'string' or length(col->>'gap')>400
      or not private.study_citations(col->'sourceIds',sources,columns,col->>'bookId') then return false; end if;
    if length(btrim(col->>'answer'))>0 then
      has_answer:=true;
      if jsonb_array_length(col->'sourceIds')=0 then return false; end if;
    elsif length(btrim(col->>'gap'))=0 then return false;
    end if;
  end loop;
  if jsonb_typeof(synthesis->'text') is distinct from 'string' or length(btrim(synthesis->>'text')) not between 1 and 1800
    or not private.study_citations(synthesis->'sourceIds',sources,columns) then return false; end if;
  return not has_answer or jsonb_array_length(synthesis->'sourceIds')>0;
end
$$;

create or replace function private.validate_study_metadata()
returns trigger language plpgsql set search_path='' as $$
declare body jsonb:=new.payload;
begin
  if new.kind in ('book','notebook') and body ? 'manualOrder'
    and not private.study_number(body->'manualOrder',0,9007199254740991,true) then
    raise exception 'Invalid manual order';
  elsif new.kind in ('notebook-media','notebook-image') and body ? 'displayWidth'
    and not private.study_number(body->'displayWidth',0.16,1) then
    raise exception 'Invalid attachment display width';
  elsif new.kind='notebook-overlay' and (
    (body ? 'scaleX' and not private.study_number(body->'scaleX',0.1,10))
    or (body ? 'scaleY' and not private.study_number(body->'scaleY',0.1,10))) then
    raise exception 'Invalid drawing dimensions';
  elsif new.kind='research-message' and body ? 'comparison'
    and not private.valid_study_comparison(body->'comparison',body->'sources') then
    raise exception 'Invalid book comparison or citations';
  end if;
  return new;
end
$$;
revoke all on function private.study_number(jsonb,numeric,numeric,boolean),
  private.study_citations(jsonb,jsonb,jsonb,text), private.valid_study_comparison(jsonb,jsonb),
  private.validate_study_metadata() from public, anon, authenticated;

create trigger study_metadata_check
  before insert or update of payload on public.library_entries
  for each row when (new.kind in ('book','notebook','notebook-media','notebook-image','notebook-overlay','research-message'))
  execute function private.validate_study_metadata();
