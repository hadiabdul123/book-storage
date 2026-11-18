-- Synthetic records only. Run after the notebook asset migration.
begin;
insert into auth.users(id,email) values
 ('18000000-0000-4000-8000-000000000001','leafmark-media-owner@example.invalid'),
 ('18000000-0000-4000-8000-000000000002','leafmark-media-other@example.invalid');
insert into private.owners values ('18000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','18000000-0000-4000-8000-000000000001',true);

do $$
declare
  payload jsonb;
  media jsonb := '{"id":"audio","noteId":"test-page","extension":"wav","title":"Audio.wav","size":52}'::jsonb || jsonb_build_object('createdAt',now(),'hash',repeat('a',64));
  placement jsonb := '{"id":"paper-drawing","noteId":"test-page","anchor":"paragraph1","x":20,"y":10,"scale":1}'::jsonb || jsonb_build_object('createdAt',now());
  rejected boolean;
begin
  payload:=jsonb_build_object('id','asset-notebook','title','Notebook','createdAt',now());
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook','id',payload->>'id','value',payload,'baseRevision',0,'createdAt',now()));
  payload:=jsonb_build_object('id','test-page','notebookId','asset-notebook','title','Page','tags','[]'::jsonb,'createdAt',now(),'updatedAt',now(),
    'document','{"type":"doc","content":[{"type":"paragraph","attrs":{"inkAnchor":"paragraph1"},"content":[{"type":"text","text":"0:01","marks":[{"type":"link","attrs":{"href":"https://example.invalid/#/notebooks?note=test-page&media=audio&at=1","title":null,"target":"_self","rel":null,"class":null}}]}]}]}'::jsonb);
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook-note','id',payload->>'id','value',payload,'baseRevision',0,'createdAt',now()));
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook-overlay','id',placement->>'id','value',placement,'baseRevision',0,'createdAt',now()));

  rejected:=false;
  begin
    perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook-media','id',media->>'id','value',media,'baseRevision',0,'createdAt',now()));
  exception when others then
    if sqlerrm <> 'Upload the original attachment first' then raise; end if;
    rejected:=true;
  end;
  if not rejected then raise exception 'Attachment metadata was accepted before upload'; end if;

  -- Simulate Storage API metadata in this rolled-back transaction.
  insert into storage.objects(bucket_id,name,metadata) values ('notebook-media', auth.uid()::text||'/test-page/audio.wav', '{"size":52,"mimetype":"audio/wav"}'::jsonb);
  perform public.apply_change(jsonb_build_object('opId',gen_random_uuid(),'kind','notebook-media','id',media->>'id','value',media,'baseRevision',0,'createdAt',now()));
  if not exists(select 1 from public.library_entries where kind='notebook-media' and id='audio' and not deleted) then raise exception 'Attachment was not saved'; end if;
  rejected:=false;
  begin
    insert into storage.objects(bucket_id,name,metadata) values ('notebook-media','18000000-0000-4000-8000-000000000002/test-page/borrowed.wav','{"size":52}'::jsonb);
  exception when insufficient_privilege then rejected:=true;
  end;
  if not rejected then raise exception 'Owner can upload to another account folder'; end if;
end $$;

select set_config('request.jwt.claim.sub','18000000-0000-4000-8000-000000000002',true);
do $$ begin
  if exists(select 1 from storage.objects where bucket_id='notebook-media') then raise exception 'Non-owner can read notebook attachments'; end if;
  if exists(select 1 from public.library_entries where kind in ('notebook-media','notebook-overlay')) then raise exception 'Non-owner can read notebook assets'; end if;
end $$;

reset role;
do $$ begin
  if (select public from storage.buckets where id='notebook-media') is distinct from false then raise exception 'Notebook media bucket is public'; end if;
  if pg_catalog.has_function_privilege('anon','public.apply_change(jsonb)','execute') then raise exception 'Anonymous sync access'; end if;
end $$;
rollback;
