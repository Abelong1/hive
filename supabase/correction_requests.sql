-- Correction requests: anyone viewing a published entry can report wrong info (name, date, adviser…)
-- with a reason. Visitors can only submit through submit_correction(); only admins can read or resolve.

create table public.correction_requests (
  id              bigint generated always as identity primary key,
  thesis_id       uuid not null references public.theses(id) on delete cascade,
  field           text not null check (field in ('title','researchers','school_year','adviser','verdict','abstract','conclusion','recommendations','tags','technologies','references','photos','other')),
  current_value   text check (char_length(current_value) <= 500),
  suggested_value text check (char_length(suggested_value) <= 500),
  reason          text not null check (reason in ('typo','wrong_info','missing_info','outdated','wrong_photo','privacy','other')),
  details         text not null check (char_length(details) between 10 and 1000),
  requester_name  text not null check (char_length(requester_name) between 2 and 120),
  requester_email text check (requester_email is null or requester_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  relation        text not null default 'visitor' check (relation in ('researcher','adviser','student','faculty','visitor')),
  status          text not null default 'open' check (status in ('open','resolved','dismissed')),
  admin_note      text check (char_length(admin_note) <= 1000),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     uuid references auth.users(id)
);
create index correction_requests_status_idx on public.correction_requests (status, created_at desc);
create index correction_requests_thesis_idx on public.correction_requests (thesis_id);

alter table public.correction_requests enable row level security;
create policy "corrections: admin read" on public.correction_requests for select to authenticated using ((select public.is_admin()));
create policy "corrections: admin update" on public.correction_requests for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
revoke all on public.correction_requests from anon, authenticated;
grant select, update (status, admin_note, resolved_at, resolved_by) on public.correction_requests to authenticated;

-- Public entry point: only for published entries, length-checked, throttled against spam.
create or replace function public.submit_correction(
  p_thesis uuid, p_field text, p_current text, p_suggested text, p_reason text,
  p_details text, p_name text, p_email text, p_relation text)
returns bigint language plpgsql security definer set search_path to '' as $$
declare v_id bigint; v_email text := nullif(lower(trim(p_email)), '');
begin
  if not exists (select 1 from public.theses where id = p_thesis and status = 'approved') then
    raise exception 'Entry not found';
  end if;
  if (select count(*) from public.correction_requests where created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many requests right now. Try again later.';
  end if;
  if (select count(*) from public.correction_requests
      where thesis_id = p_thesis and status = 'open' and created_at > now() - interval '1 day') >= 10 then
    raise exception 'This entry already has several open reports. ACES will review them soon.';
  end if;
  if v_email is not null and (select count(*) from public.correction_requests
      where requester_email = v_email and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Daily limit reached for this email.';
  end if;
  insert into public.correction_requests (thesis_id, field, current_value, suggested_value, reason, details, requester_name, requester_email, relation)
  values (p_thesis, p_field, nullif(trim(p_current), ''), nullif(trim(p_suggested), ''), p_reason,
          trim(p_details), trim(p_name), v_email, coalesce(nullif(p_relation, ''), 'visitor'))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.submit_correction(uuid,text,text,text,text,text,text,text,text) from public;
grant execute on function public.submit_correction(uuid,text,text,text,text,text,text,text,text) to anon, authenticated;
