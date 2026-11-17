-- Synthetic records only. Run after all migrations; every write rolls back.
begin;
insert into auth.users(id,email) values ('17000000-0000-4000-8000-000000000001','leafmark-ink-test@example.invalid');
insert into private.owners values ('17000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','17000000-0000-4000-8000-000000000001',true);
do $$
declare value jsonb; result jsonb; rejected boolean:=false; item text;
begin
  value:=jsonb_build_object('id','ink-notebook','title','Notebook','createdAt',now());
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook','id',value->>'id','value',value,'baseRevision',0,'createdAt',now()));
  value:=jsonb_build_object('id','ink-section','notebookId','ink-notebook','title','Section','order',1,'createdAt',now());
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook-section','id',value->>'id','value',value,'baseRevision',0,'createdAt',now()));
  value:=jsonb_build_object('id','ink-page','notebookId','ink-notebook','sectionId','ink-section','title','Page','tags','[]'::jsonb,'document','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Keep","marks":[{"type":"highlight","attrs":{"color":"#f4cc60"}},{"type":"underline"}]}]},{"type":"drawing","attrs":{"blockId":"canvas","height":300}}]}'::jsonb,'createdAt',now(),'updatedAt',now());
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook-note','id',value->>'id','value',value,'baseRevision',0,'createdAt',now()));
  value:=jsonb_build_object('id','ink-stroke-one','target',jsonb_build_object('type','notebook','noteId','ink-page','blockId','canvas'),'tool','pen','color','#315c86','width',2,'points','[[10,20,0.5],[30,50,0.7]]'::jsonb,'createdAt',now());
  result:=public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','ink-stroke','id',value->>'id','value',value,'baseRevision',0,'createdAt',now()));
  if result->'row'->>'kind'<>'ink-stroke' then raise exception 'Drawing was not saved'; end if;
  -- Independent strokes coexist, even with a stale base revision.
  value:=jsonb_set(value,'{id}','"ink-stroke-two"');
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','ink-stroke','id',value->>'id','value',value,'baseRevision',0,'createdAt',now()));
  if (select count(*) from public.library_entries where kind='ink-stroke' and id in ('ink-stroke-one','ink-stroke-two') and not deleted)<>2 then raise exception 'Concurrent addition lost'; end if;
  foreach item in array array['missing-parent','bad-pressure','unsafe-color','wrong-edition'] loop
    begin
      value:=jsonb_set(value,'{id}',to_jsonb(item));
      if item='missing-parent' then value:=jsonb_set(value,'{target,noteId}','"missing"');
      elsif item='bad-pressure' then value:=jsonb_set(value,'{target,noteId}','"ink-page"'); value:=jsonb_set(value,'{points}','[[10,20,9]]');
      elsif item='unsafe-color' then value:=jsonb_set(value,'{points}','[[10,20,0.5]]'); value:=jsonb_set(value,'{color}','"url(https://example.invalid)"');
      else value:=jsonb_set(value,'{color}','"#315c86"'); value:=jsonb_set(value,'{target}','{"type":"pdf","bookId":"missing","hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","page":1}');
      end if;
      rejected:=false;
      perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','ink-stroke','id',value->>'id','value',value,'baseRevision',0,'createdAt',now()));
    exception when others then rejected:=true;
    end;
    if not rejected then raise exception 'Invalid drawing accepted: %',item; end if;
  end loop;
  begin
    rejected:=false;
    value:=jsonb_build_object('id','unsafe-page','notebookId','ink-notebook','title','Unsafe','tags','[]'::jsonb,'createdAt',now(),'updatedAt',now(),'document','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Unsafe","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]}]}]}'::jsonb);
    perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook-note','id',value->>'id','value',value,'baseRevision',0,'createdAt',now()));
  exception when others then rejected:=true;
  end;
  if not rejected then raise exception 'Executable link accepted'; end if;
end $$;
rollback;
