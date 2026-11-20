-- Text boxes remain ordinary paragraphs so earlier readers can display their text.
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
    if exists(select 1 from jsonb_object_keys(attrs) k where not ((t='paragraph' and k='textBox') or ((t in ('paragraph','heading') and k='inkAnchor') or (t='heading' and k='level')) or (t='orderedList' and k in ('start','type')) or (t='taskItem' and k='checked'))) then return false; end if;
    if attrs ? 'textBox' then
      declare box jsonb:=attrs->'textBox'; pos jsonb:=box->'free';
      begin
        if depth<>1 or jsonb_typeof(box) is distinct from 'object'
          or exists(select 1 from jsonb_object_keys(box) k where k not in ('width','minHeight','tint','free'))
          or not private.study_number(box->'width',0.2,1)
          or not private.study_number(box->'minHeight',48,800)
          or jsonb_typeof(box->'tint') is distinct from 'boolean' then return false; end if;
        if pos is not null and (jsonb_typeof(pos) is distinct from 'object'
          or exists(select 1 from jsonb_object_keys(pos) k where k not in ('x','y'))
          or not private.study_number(pos->'x',0,1.00001-(box->>'width')::numeric)
          or not private.study_number(pos->'y',0,100)) then return false; end if;
      end;
    end if;
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
