create or replace function private.valid_pdf_text_box(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
begin
  return jsonb_typeof(v)='object' and length(v::text)<=30000
    and jsonb_typeof(v->'id')='string' and length(v->>'id') between 1 and 100
    and jsonb_typeof(v->'bookId')='string' and length(v->>'bookId') between 1 and 100
    and jsonb_typeof(v->'hash')='string' and v->>'hash' ~ '^[a-f0-9]{64}$'
    and private.study_number(v->'page',1,100000,true)
    and private.study_number(v->'x',-100000,100000)
    and private.study_number(v->'y',-100000,100000)
    and private.study_number(v->'width',1,100000)
    and private.study_number(v->'height',1,100000)
    and jsonb_typeof(v->'rotation')='number' and (v->>'rotation')::numeric in (0,90,180,270)
    and jsonb_typeof(v->'text')='string' and length(v->>'text') between 1 and 4000 and v->>'text' ~ '[^[:space:]]'
    and private.study_number(v->'fontSize',8,72)
    and (not (v ? 'transparent') or jsonb_typeof(v->'transparent')='boolean')
    and (not (v ? 'underline') or jsonb_typeof(v->'underline')='boolean')
    and (not (v ? 'weight') or (jsonb_typeof(v->'weight')='string' and v->>'weight' in ('light','regular','bold')))
    and jsonb_typeof(v->'tint')='boolean'
    and jsonb_typeof(v->'createdAt')='string' and isfinite((v->>'createdAt')::timestamptz)
    and jsonb_typeof(v->'updatedAt')='string' and isfinite((v->>'updatedAt')::timestamptz);
exception when others then return false;
end;
$$;
revoke all on function private.valid_pdf_text_box(jsonb) from public, anon, authenticated;
