-- Run after all migrations. Synthetic data only; every write rolls back.
begin;
insert into auth.users(id,email) values ('10000000-0000-4000-8000-000000000001','leafmark-latest-test@example.invalid');
insert into private.owners values ('10000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$
declare b jsonb; older jsonb; newer jsonb; result jsonb; again jsonb; before_revision bigint;
begin
  b := jsonb_build_object('opId','20000000-0000-4000-8000-000000000001','kind','book','id','latest-test','baseRevision',0,
    'createdAt','2026-01-01T00:00:00Z','deleted',false,'value',jsonb_build_object('id','latest-test','format','pdf','hash',repeat('a',64),'sourcePath','latest-test/source.pdf'));
  perform public.apply_change(b);
  older := jsonb_build_object('opId','20000000-0000-4000-8000-000000000002','kind','annotation','id','hello','baseRevision',0,
    'createdAt','2026-01-02T00:00:00Z','deleted',false,'value',jsonb_build_object('id','hello','bookId','latest-test','text','hello','locator',jsonb_build_object('hash',repeat('a',64))));
  newer := older || jsonb_build_object('opId','20000000-0000-4000-8000-000000000003','createdAt','2026-01-03T00:00:00Z','deleted',true);
  perform public.apply_change(older);
  result := public.apply_change(newer); -- stale base, but newer deletion
  if result->>'conflict' <> 'false' or result->'row'->>'deleted' <> 'true' then raise exception 'New deletion blocked'; end if;
  before_revision := (result->'row'->>'revision')::bigint;
  result := public.apply_change(older || jsonb_build_object('opId','20000000-0000-4000-8000-000000000004','baseRevision',before_revision));
  if result->>'superseded' <> 'true' or result->'row'->>'deleted' <> 'true' or (result->'row'->>'revision')::bigint <> before_revision then raise exception 'Delayed older edit resurrected highlight'; end if;
  -- Retry receipts are stable, without allocating new revisions.
  again := public.apply_change(older || jsonb_build_object('opId','20000000-0000-4000-8000-000000000004','baseRevision',before_revision));
  if result <> again then raise exception 'Superseded retry not idempotent'; end if;
  -- Even a higher UUID cannot undo a same-time deletion.
  result := public.apply_change(older || jsonb_build_object('opId','ffffffff-ffff-4fff-8fff-ffffffffffff','createdAt','2026-01-03T00:00:00Z'));
  if result->'row'->>'deleted' <> 'true' then raise exception 'Deletion tie lost'; end if;
  -- A real later restore does win, despite stale base revision.
  result := public.apply_change(older || jsonb_build_object('opId','20000000-0000-4000-8000-000000000005','createdAt','2026-01-04T00:00:00Z'));
  if result->'row'->>'deleted' <> 'false' then raise exception 'Later restore did not win'; end if;
  if (result->'row'->>'editedAt')::timestamptz <> '2026-01-04T00:00:00Z'::timestamptz then raise exception 'Edit time replaced with upload time'; end if;
  -- Reverse upload order converges to the same deletion.
  newer := jsonb_set(newer || jsonb_build_object('id','reverse','opId','20000000-0000-4000-8000-000000000006'),'{value,id}','"reverse"');
  older := jsonb_set(older || jsonb_build_object('id','reverse','opId','20000000-0000-4000-8000-000000000007'),'{value,id}','"reverse"');
  perform public.apply_change(newer);
  result := public.apply_change(older);
  if result->'row'->>'deleted' <> 'true' then raise exception 'Upload order changed winner'; end if;
end $$;
rollback;
