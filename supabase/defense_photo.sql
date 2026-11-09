-- Adds a defense-day photo (group with adviser) to each thesis entry.
-- Paste into Supabase → SQL Editor (Hive project) and click Run. Safe to run more than once.

alter table public.theses
  add column if not exists defense_photo_url text not null default '',
  add column if not exists defense_photo_caption text not null default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'theses_defense_photo_url_check') then
    alter table public.theses add constraint theses_defense_photo_url_check
      check (defense_photo_url = '' or defense_photo_url ~ '^https://');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'theses_defense_photo_caption_check') then
    alter table public.theses add constraint theses_defense_photo_caption_check
      check (char_length(defense_photo_caption) <= 300);
  end if;
end $$;

-- Include the new fields in the activity log's before/after view, if the activity log is installed.
do $$
begin
  if to_regprocedure('public.theses_content(public.theses)') is not null then
    execute $f$
      create or replace function public.theses_content(t public.theses) returns jsonb
      language sql stable set search_path to '' as $b$
        select jsonb_build_object(
          'title', t.title, 'school_year', t.school_year, 'adviser', t.adviser, 'abstract', t.abstract,
          'conclusion', t.conclusion, 'recommendations', t.recommendations, 'tags', to_jsonb(t.tags),
          'technologies', to_jsonb(t.technologies), 'refs', to_jsonb(t.refs),
          'device_photo_url', t.device_photo_url, 'device_photo_caption', t.device_photo_caption,
          'defense_photo_url', t.defense_photo_url, 'defense_photo_caption', t.defense_photo_caption)
      $b$;
    $f$;
  end if;
end $$;

notify pgrst, 'reload schema';

-- Visitors (anon) need column-level read access to the new columns.
grant select (defense_photo_url, defense_photo_caption) on public.theses to anon;
