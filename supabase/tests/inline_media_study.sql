-- Synthetic owner and attachment metadata. Everything is rolled back.
begin;
insert into auth.users(id,email) values
 ('18000000-0000-4000-8000-000000000011','leafmark-inline-owner@example.invalid'),
 ('18000000-0000-4000-8000-000000000012','leafmark-inline-viewer@example.invalid');
insert into private.owners values ('18000000-0000-4000-8000-000000000011');
set local role authenticated;
select set_config('request.jwt.claim.sub','18000000-0000-4000-8000-000000000011',true);

do $$
declare
  edition text := repeat('b',64);
  image jsonb := '{"id":"study-image","noteId":"study-note","extension":"png","title":"diagram.png","size":52,"placement":{"after":"anchor-1","order":0}}'::jsonb || jsonb_build_object('createdAt',now(),'hash',repeat('a',64));
  followup jsonb := jsonb_build_object('id','test-follow-up','annotationId','study-quote','text','Retain this follow-up.','createdAt',now());
  rejected boolean;
begin
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','book','id','study-pdf','baseRevision',0,'createdAt',now(),
    'value',jsonb_build_object('id','study-pdf','format','pdf','hash',edition,'sourcePath','study-pdf/source.pdf')));
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','annotation','id','study-quote','baseRevision',0,'createdAt',now(),
    'value',jsonb_build_object('id','study-quote','bookId','study-pdf','note','Original note','locator',jsonb_build_object('hash',edition))));
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','highlight-study','id','study-quote','baseRevision',0,'createdAt',now(),
    'value','{"id":"study-quote","priority":"important"}'::jsonb));
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','highlight-followup','id','test-follow-up','baseRevision',0,'createdAt',now(),'value',followup));
  if not exists(select 1 from public.library_entries where kind='annotation' and id='study-quote' and payload->>'note'='Original note')
    then raise exception 'Follow-up changed the original note'; end if;
  if not exists(select 1 from public.library_entries where kind='highlight-followup' and id='test-follow-up' and payload->>'text'='Retain this follow-up.')
    then raise exception 'Follow-up is missing'; end if;
  rejected:=false;
  begin
    perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','highlight-study','id','missing','baseRevision',0,'createdAt',now(),
      'value','{"id":"missing","priority":"lower"}'::jsonb));
  exception when others then
    if sqlerrm <> 'Highlight is missing' then raise; end if;
    rejected:=true;
  end;
  if not rejected then raise exception 'Accepted study record without a highlight'; end if;

  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook','id','study-notebook','baseRevision',0,'createdAt',now(),
    'value',jsonb_build_object('id','study-notebook','title','Study notebook','createdAt',now())));
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook-note','id','study-note','baseRevision',0,'createdAt',now(),
    'value',jsonb_build_object('id','study-note','notebookId','study-notebook','title','Study note','tags','[]'::jsonb,'createdAt',now(),'updatedAt',now(),
      'document','{"type":"doc","content":[{"type":"paragraph","attrs":{"inkAnchor":"anchor-1"}}]}'::jsonb)));
  insert into storage.objects(bucket_id,name,metadata) values
    ('notebook-media',auth.uid()::text||'/study-note/study-image.png','{"size":52,"mimetype":"image/png"}'::jsonb);
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook-image','id','study-image','baseRevision',0,'createdAt',now(),'value',image));
  if not exists(select 1 from public.library_entries where kind='notebook-image' and id='study-image' and payload->'placement'->>'after'='anchor-1')
    then raise exception 'Image placement is missing'; end if;
  rejected:=false;
  begin
    perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook-media','id','study-image','baseRevision',0,'createdAt',now(),'value',image));
  exception when others then
    if sqlerrm <> 'Invalid attachment' then raise; end if;
    rejected:=true;
  end;
  if not rejected then raise exception 'Legacy media records accepted an image'; end if;
end $$;

select set_config('request.jwt.claim.sub','18000000-0000-4000-8000-000000000012',true);
do $$ begin
  if exists(select 1 from storage.objects where bucket_id='notebook-media') then raise exception 'Non-owner can read private images'; end if;
  if exists(select 1 from public.library_entries where kind in ('notebook-image','highlight-study','highlight-followup')) then raise exception 'Non-owner can read study data'; end if;
end $$;
reset role;
do $$ begin
  if (select public from storage.buckets where id='notebook-media') is distinct from false then raise exception 'Attachment bucket must remain private'; end if;
  if pg_catalog.has_function_privilege('anon','public.apply_change(jsonb)','execute') then raise exception 'Anonymous sync access'; end if;
end $$;
rollback;
