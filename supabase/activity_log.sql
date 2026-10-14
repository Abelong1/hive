-- HIVE activity log: one append-only table, written only by triggers / security-definer functions.
-- Admins can read it; nobody (not even admins via the API) can edit or delete it.

create table public.activity_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_id     uuid,
  actor_email  text,
  category     text not null check (category in ('edit','status','code','consent','adviser','auth')),
  action       text not null,
  thesis_id    uuid,
  thesis_title text,
  target       text,
  changed      text[] not null default '{}',
  before       jsonb,
  after        jsonb,
  details      jsonb not null default '{}'
);
create index activity_log_at_idx on public.activity_log (at desc);
create index activity_log_cat_idx on public.activity_log (category, at desc);
create index activity_log_thesis_idx on public.activity_log (thesis_id, at desc);
create index activity_log_actor_idx on public.activity_log (actor_id, at desc);

alter table public.activity_log enable row level security;
create policy "activity: admin read" on public.activity_log for select to authenticated using ((select public.is_admin()));
revoke all on public.activity_log from anon, authenticated;
grant select on public.activity_log to authenticated;

-- ---------- internal writer ----------
create or replace function public.log_activity(
  p_category text, p_action text, p_thesis uuid, p_target text,
  p_changed text[], p_before jsonb, p_after jsonb, p_details jsonb default '{}',
  p_actor uuid default null)
returns bigint language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := coalesce(p_actor, auth.uid()); v_id bigint;
begin
  insert into public.activity_log (actor_id, actor_email, category, action, thesis_id, thesis_title, target, changed, before, after, details)
  values (
    v_actor,
    (select email from auth.users where id = v_actor),
    p_category, p_action, p_thesis,
    (select title from public.theses where id = p_thesis),
    p_target, coalesce(p_changed, '{}'), p_before, p_after, coalesce(p_details, '{}'))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.log_activity(text,text,uuid,text,text[],jsonb,jsonb,jsonb,uuid) from public, anon, authenticated;

-- ---------- theses ----------
create or replace function public.theses_content(t public.theses) returns jsonb
language sql stable set search_path to '' as $$
  select jsonb_build_object(
    'title', t.title, 'school_year', t.school_year, 'adviser', t.adviser, 'abstract', t.abstract,
    'conclusion', t.conclusion, 'recommendations', t.recommendations, 'tags', to_jsonb(t.tags),
    'technologies', to_jsonb(t.technologies), 'refs', to_jsonb(t.refs),
    'device_photo_url', t.device_photo_url, 'device_photo_caption', t.device_photo_caption)
$$;

create or replace function public.theses_audit() returns trigger
language plpgsql security definer set search_path to '' as $$
declare o jsonb; n jsonb; k text; ch text[] := '{}'; b jsonb := '{}'; a jsonb := '{}';
begin
  if tg_op = 'INSERT' then
    perform public.log_activity('edit', 'created', new.id, new.title, '{}', null, public.theses_content(new),
      jsonb_build_object('status', new.status, 'sample', new.is_sample));
    return null;
  end if;
  if tg_op = 'DELETE' then
    insert into public.activity_log (actor_id, actor_email, category, action, thesis_id, thesis_title, target, before, details)
    values (auth.uid(), (select email from auth.users where id = auth.uid()), 'edit', 'deleted', old.id, old.title, old.title,
      public.theses_content(old), jsonb_build_object('status', old.status, 'sample', old.is_sample));
    return null;
  end if;
  o := public.theses_content(old); n := public.theses_content(new);
  for k in select jsonb_object_keys(n) loop
    if o->k is distinct from n->k then
      ch := ch || k; b := b || jsonb_build_object(k, o->k); a := a || jsonb_build_object(k, n->k);
    end if;
  end loop;
  if array_length(ch, 1) > 0 then
    perform public.log_activity('edit', 'edited', new.id, new.title, ch, b, a);
  end if;
  if old.status is distinct from new.status then
    perform public.log_activity('status',
      case new.status when 'pending' then 'submitted' when 'approved' then 'approved'
        when 'rejected' then case when old.status = 'approved' then 'taken down' else 'rejected' end
        else 'moved to draft' end,
      new.id, new.title, array['status'], jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
  end if;
  if old.consent_given is distinct from new.consent_given then
    perform public.log_activity('consent', case when new.consent_given then 'consent given' else 'consent withdrawn' end,
      new.id, new.title, array['consent_given'], jsonb_build_object('consent_given', old.consent_given),
      jsonb_build_object('consent_given', new.consent_given, 'groupmates_informed', new.groupmates_informed));
  end if;
  return null;
end $$;
create trigger theses_audit_trg after insert or update or delete on public.theses
  for each row execute function public.theses_audit();

-- ---------- researchers (portal deletes then re-inserts the list; pair them into one entry) ----------
create or replace function public.researcher_list(p_thesis uuid, p_exclude uuid[] default '{}') returns jsonb
language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'photo_url', photo_url) order by position, name), '[]')
  from public.researchers where thesis_id = p_thesis and not (id = any(p_exclude))
$$;
revoke all on function public.researcher_list(uuid, uuid[]) from public, anon, authenticated;

create or replace function public.researchers_audit_del() returns trigger
language plpgsql security definer set search_path to '' as $$
declare r record;
begin
  for r in select thesis_id, jsonb_agg(jsonb_build_object('name', name, 'photo_url', photo_url) order by position, name) gone
           from old_rows group by thesis_id loop
    continue when not exists (select 1 from public.theses where id = r.thesis_id); -- whole entry deleted; theses log covers it
    perform public.log_activity('edit', 'researchers', r.thesis_id, 'researchers', array['researchers'],
      public.researcher_list(r.thesis_id) || r.gone, null, jsonb_build_object('open', true));
  end loop;
  return null;
end $$;

create or replace function public.researchers_audit_ins() returns trigger
language plpgsql security definer set search_path to '' as $$
declare r record; v_log bigint; v_before jsonb; v_after jsonb;
begin
  for r in select thesis_id, array_agg(id) ids from new_rows group by thesis_id loop
    v_after := public.researcher_list(r.thesis_id);
    v_log := null;
    select id, before into v_log, v_before from public.activity_log
      where thesis_id = r.thesis_id and action = 'researchers' and details ? 'open'
        and actor_id is not distinct from auth.uid() and at > now() - interval '10 minutes'
      order by id desc limit 1;
    if v_log is not null then
      if v_before = v_after then
        delete from public.activity_log where id = v_log;          -- saved with no researcher change
      else
        update public.activity_log set after = v_after, details = details - 'open' where id = v_log;
      end if;
    else
      perform public.log_activity('edit', 'researchers', r.thesis_id, 'researchers', array['researchers'],
        public.researcher_list(r.thesis_id, r.ids), v_after);
    end if;
  end loop;
  return null;
end $$;

create or replace function public.researchers_audit_upd() returns trigger
language plpgsql security definer set search_path to '' as $$
declare r record;
begin
  for r in select n.thesis_id,
      jsonb_agg(jsonb_build_object('name', o.name, 'photo_url', o.photo_url) order by n.position) b,
      jsonb_agg(jsonb_build_object('name', n.name, 'photo_url', n.photo_url) order by n.position) a
    from new_rows n join old_rows o on o.id = n.id
    where (o.name, o.photo_url, o.position) is distinct from (n.name, n.photo_url, n.position)
    group by n.thesis_id loop
    perform public.log_activity('edit', 'researchers', r.thesis_id, 'researchers', array['researchers'], r.b, r.a);
  end loop;
  return null;
end $$;

create trigger researchers_audit_del_trg after delete on public.researchers
  referencing old table as old_rows for each statement execute function public.researchers_audit_del();
create trigger researchers_audit_ins_trg after insert on public.researchers
  referencing new table as new_rows for each statement execute function public.researchers_audit_ins();
create trigger researchers_audit_upd_trg after update on public.researchers
  referencing old table as old_rows new table as new_rows for each statement execute function public.researchers_audit_upd();

-- ---------- advisers ----------
create or replace function public.advisers_audit() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if tg_op = 'DELETE' then
    perform public.log_activity('adviser', 'removed', null, old.name, '{}', to_jsonb(old) - 'updated_at', null);
  elsif tg_op = 'INSERT' or old.photo_url is distinct from new.photo_url then
    perform public.log_activity('adviser', case when new.photo_url = '' then 'photo removed' else 'photo set' end,
      null, new.name, array['photo_url'],
      case when tg_op = 'UPDATE' then jsonb_build_object('photo_url', old.photo_url) end,
      jsonb_build_object('photo_url', new.photo_url));
  end if;
  return null;
end $$;
create trigger advisers_audit_trg after insert or update or delete on public.advisers
  for each row execute function public.advisers_audit();

-- ---------- invite codes ----------
create or replace function public.codes_audit() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity('code', 'created', null, new.code, '{}', null,
      jsonb_build_object('note', new.note, 'expires_at', new.expires_at), '{}', new.created_by);
  else
    if old.used_at is null and new.used_at is not null then
      perform public.log_activity('code', 'redeemed', null, new.code, '{}', null,
        jsonb_build_object('note', new.note), '{}', new.used_by);
    end if;
    if not old.revoked and new.revoked then
      perform public.log_activity('code', 'revoked', null, new.code, '{}', null, jsonb_build_object('note', new.note));
    end if;
  end if;
  return null;
end $$;
create trigger codes_audit_trg after insert or update on public.invite_codes
  for each row execute function public.codes_audit();

-- ---------- consent log rows ----------
create or replace function public.consent_audit() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  perform public.log_activity('consent', 'consent recorded', new.thesis_id, null, '{}', null,
    jsonb_build_object('notice_version', new.notice_version, 'groupmates_informed', new.groupmates_informed), '{}', new.user_id);
  return null;
end $$;
create trigger consent_audit_trg after insert on public.consent_log
  for each row execute function public.consent_audit();

-- ---------- sign-ins: failed attempts reported by the portal (throttled) ----------
create or replace function public.report_failed_login(p_email text) returns void
language plpgsql security definer set search_path to '' as $$
declare v_email text := lower(left(trim(coalesce(p_email, '')), 200));
begin
  if v_email !~ '^[^@\s]+@[^@\s]+$' then return; end if;
  if (select count(*) from public.activity_log where category = 'auth' and action = 'failed login'
        and target = v_email and at > now() - interval '1 hour') >= 30 then return; end if;
  if (select count(*) from public.activity_log where category = 'auth' and action = 'failed login'
        and at > now() - interval '1 minute') >= 60 then return; end if;
  insert into public.activity_log (category, action, target, details)
  values ('auth', 'failed login', v_email, jsonb_build_object('source', 'portal'));
end $$;
revoke all on function public.report_failed_login(text) from public;
grant execute on function public.report_failed_login(text) to anon, authenticated;

-- ---------- admin readers ----------
-- Supabase auth audit log (login, logout, signup, password reset...). Empty until
-- "Disable writing auth audit logs to project database" is OFF in the dashboard.
create or replace function public.admin_auth_events(p_since timestamptz default now() - interval '30 days', p_limit int default 500)
returns table (at timestamptz, action text, email text, user_id uuid, ip text)
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select * from (
      select e.created_at, e.payload->>'action',
        coalesce(e.payload->>'actor_username', e.payload->'traits'->>'user_email', u.email::text),
        u.id, e.ip_address::text
      from auth.audit_log_entries e
      left join auth.users u on u.id::text = e.payload->>'actor_id'
      where e.created_at >= p_since and coalesce(e.payload->>'action', '') <> 'token_refreshed'
      union all
      select l.at, l.action, l.target, null::uuid, null::text
      from public.activity_log l where l.category = 'auth' and l.at >= p_since
    ) q order by 1 desc limit least(greatest(p_limit, 1), 2000);
end $$;
revoke all on function public.admin_auth_events(timestamptz, int) from public, anon;
grant execute on function public.admin_auth_events(timestamptz, int) to authenticated;

-- Accounts: sign-up time, email confirmed, last sign-in (always available).
create or replace function public.admin_accounts()
returns table (user_id uuid, email text, full_name text, role text, created_at timestamptz,
               confirmed_at timestamptz, last_sign_in_at timestamptz, recovery_sent_at timestamptz)
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select u.id, u.email::text, p.full_name, coalesce(p.role, 'no profile'), u.created_at,
           u.email_confirmed_at, u.last_sign_in_at, u.recovery_sent_at
    from auth.users u left join public.profiles p on p.id = u.id
    order by u.last_sign_in_at desc nulls last;
end $$;
revoke all on function public.admin_accounts() from public, anon;
grant execute on function public.admin_accounts() to authenticated;

-- Simple alerts: repeated failed logins and bursts of edits.
create or replace function public.admin_alerts()
returns table (kind text, who text, n bigint, first_at timestamptz, last_at timestamptz)
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select * from (
      select 'Repeated failed logins'::text, x.who, count(*), min(x.at), max(x.at) from (
        select l.target who, l.at from public.activity_log l
          where l.category = 'auth' and l.action = 'failed login' and l.at > now() - interval '24 hours'
      ) x group by x.who having count(*) >= 5
      union all
      select 'Many changes in a short time'::text, coalesce(l.actor_email, l.actor_id::text), count(*), min(l.at), max(l.at)
        from public.activity_log l
        where l.category in ('edit', 'status', 'adviser') and l.at > now() - interval '24 hours' and l.actor_id is not null
        group by l.actor_email, l.actor_id, date_trunc('hour', l.at)
        having count(*) >= 25
    ) q order by 5 desc;
end $$;
revoke all on function public.admin_alerts() from public, anon;
grant execute on function public.admin_alerts() to authenticated;

-- Restore an entry's fields (or its researcher list) to the "before" side of a log row.
create or replace function public.admin_restore(p_log_id bigint) returns text
language plpgsql security definer set search_path to '' as $$
declare l public.activity_log%rowtype; t public.theses%rowtype; r public.theses%rowtype;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into l from public.activity_log where id = p_log_id;
  if not found or l.category <> 'edit' or l.before is null then raise exception 'nothing to restore' using errcode = 'P0001'; end if;
  select * into t from public.theses where id = l.thesis_id for update;
  if not found then raise exception 'that entry no longer exists' using errcode = 'P0001'; end if;

  if l.action = 'edited' then
    r := jsonb_populate_record(t, l.before);
    update public.theses set title = r.title, school_year = r.school_year, adviser = r.adviser, abstract = r.abstract,
      conclusion = r.conclusion, recommendations = r.recommendations, tags = r.tags, technologies = r.technologies,
      refs = r.refs, device_photo_url = r.device_photo_url, device_photo_caption = r.device_photo_caption
    where id = t.id;
  elsif l.action = 'researchers' then
    delete from public.researchers where thesis_id = t.id;
    insert into public.researchers (thesis_id, name, photo_url, position)
      select t.id, e.value->>'name', coalesce(e.value->>'photo_url', ''), (e.ordinality - 1)::int
      from jsonb_array_elements(l.before) with ordinality e;
  else
    raise exception 'this kind of change cannot be restored' using errcode = 'P0001';
  end if;
  update public.activity_log set details = details || jsonb_build_object('restored_from', p_log_id)
    where id = (select max(id) from public.activity_log where thesis_id = t.id and actor_id = auth.uid() and id > p_log_id);
  return 'restored';
end $$;
revoke all on function public.admin_restore(bigint) from public, anon;
grant execute on function public.admin_restore(bigint) to authenticated;

revoke all on function public.theses_audit(), public.researchers_audit_del(), public.researchers_audit_ins(),
  public.researchers_audit_upd(), public.advisers_audit(), public.codes_audit(), public.consent_audit() from public, anon, authenticated;
