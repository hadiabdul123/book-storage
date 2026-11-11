-- Run in the SQL editor AFTER 001_library.sql. All test data rolls back.
begin;
do $$ begin
  if not exists(select 1 from storage.buckets where id='library' and not public)
    then raise exception 'Library storage bucket is missing or public'; end if;
end $$;
insert into auth.users(id,email) values
  ('10000000-0000-4000-8000-000000000001','leafmark-owner-test@example.invalid'),
  ('10000000-0000-4000-8000-000000000002','leafmark-denied-test@example.invalid');
insert into private.owners values('10000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$
declare first_result jsonb; retry jsonb; conflict jsonb; op jsonb;
begin
  if not public.is_library_owner() then raise exception 'Owner rejected'; end if;
  op:=jsonb_build_object('opId','20000000-0000-4000-8000-000000000001','kind','book','id','test-book','baseRevision',0,'deleted',false,
    'value',jsonb_build_object('id','test-book','title','Test','format','epub','hash',repeat('a',64),'sourcePath','test-book/source.epub'));
  first_result:=public.apply_change(op);
  retry:=public.apply_change(op);
  if first_result<>retry then raise exception 'Retry is not idempotent'; end if;
  conflict:=public.apply_change(op||jsonb_build_object('opId','20000000-0000-4000-8000-000000000002'));
  if conflict->>'conflict'<>'true' then raise exception 'Stale update was accepted'; end if;
  if jsonb_array_length(public.pull_changes(0))<>1 then raise exception 'Pull returned the wrong records'; end if;
  begin
    insert into public.library_entries(owner_id,kind,id,payload,revision) values(auth.uid(),'book','direct','{}',999);
    raise exception 'Direct writes unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$ begin
  if public.is_library_owner() then raise exception 'Unapproved account accepted'; end if;
  if exists(select 1 from public.library_entries) then raise exception 'Another account can read private data'; end if;
  begin perform public.pull_changes(0);raise exception 'Unapproved pull accepted';exception when insufficient_privilege then null;end;
  begin perform public.apply_change('{"opId":"20000000-0000-4000-8000-000000000003"}'::jsonb);raise exception 'Unapproved write accepted';exception when insufficient_privilege then null;end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform 1 from public.library_entries;raise exception 'Anonymous read accepted';exception when insufficient_privilege then null;end;
end $$;
rollback;
