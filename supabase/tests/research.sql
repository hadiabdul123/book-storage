-- Synthetic owner/non-owner, replay and quota tests. No personal rows retained.
begin;
insert into auth.users(id,email) values
  ('10000000-0000-4000-8000-000000000001','leafmark-research-test@example.invalid'),
  ('10000000-0000-4000-8000-000000000002','leafmark-denied-research-test@example.invalid');
insert into private.owners values('10000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$
declare result jsonb; op jsonb; i integer;
begin
  op:=jsonb_build_object('opId',gen_random_uuid(),'kind','notebook','id','research-test','baseRevision',0,'createdAt',clock_timestamp(),
    'value',jsonb_build_object('id','research-test','title','Test notebook','createdAt',clock_timestamp()));
  result:=public.apply_change(op);
  if result->'row'->>'kind'<>'notebook' then raise exception 'Notebook save failed'; end if;
  op:=jsonb_build_object('opId',gen_random_uuid(),'kind','notebook-note','id','research-note','baseRevision',0,'createdAt',clock_timestamp(),
    'value',jsonb_build_object('id','research-note','notebookId','research-test','title','Note','createdAt',clock_timestamp(),'updatedAt',clock_timestamp(),
      'document','{"type":"doc","content":[]}'::jsonb,'tags','[]'::jsonb));
  perform public.apply_change(op);
  begin
    perform public.apply_change(op||jsonb_build_object('opId',gen_random_uuid(),'id','missing-parent','value',(op->'value')||'{"id":"missing-parent","notebookId":"absent"}'::jsonb));
    raise exception 'Missing parent accepted';
  exception when raise_exception then if sqlerrm='Missing parent accepted' then raise; end if; end;
  result:=public.research_begin('30000000-0000-4000-8000-000000000001','web');
  if result->>'state'<>'new' then raise exception 'Reservation failed'; end if;
  result:=public.research_begin('30000000-0000-4000-8000-000000000001','web');
  if result->>'state'<>'busy' then raise exception 'Duplicate request ran twice'; end if;
  perform public.research_finish('30000000-0000-4000-8000-000000000001','{"answer":"Test answer","sources":[],"model":"test"}'::jsonb);
  result:=public.research_begin('30000000-0000-4000-8000-000000000001','web');
  if result->>'state'<>'cached' or result->'result'->>'answer'<>'Test answer' then raise exception 'Result replay failed'; end if;
  for i in 1..19 loop perform public.research_begin(gen_random_uuid(),'web'); end loop;
  result:=public.research_begin(gen_random_uuid(),'web');
  if result->>'state'<>'limited' then raise exception 'Rate guard failed'; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$ begin
  if exists(select 1 from public.library_entries) then raise exception 'Other account read notebook'; end if;
  begin perform public.research_begin(gen_random_uuid(),'web'); raise exception 'Unapproved request accepted'; exception when insufficient_privilege then null; end;
  begin perform public.research_finish(gen_random_uuid(),null); raise exception 'Unapproved finish accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  if has_function_privilege(current_user,'public.research_begin(uuid,text)','EXECUTE') or has_function_privilege(current_user,'public.research_finish(uuid,jsonb)','EXECUTE') then raise exception 'Anonymous research RPC granted'; end if;
end $$;
rollback;
