-- #20 Delete account (plan §7, PRD "Delete account"):
-- S6 → POST /api/account/delete marks profiles.deletion_requested_at (server only, service role).
-- A daily pg_cron job then hard-deletes every marked account, well within the 7 days the PRD allows.
-- Deleting the auth user cascades to profiles → baskets, basket_items, savings_events, notifications.
-- report_logs keep the report but lose the user (on delete set null), so store data stays correct.
-- login_attempts are keyed by email (no foreign key), so they are deleted here by hand.

alter table public.profiles add column deletion_requested_at timestamptz;
-- Clients can only update display_name and suburb_id (rls migration), so this column is server-only.

create or replace function public.purge_deleted_accounts()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  delete from public.login_attempts la
   using public.profiles p
   where p.deletion_requested_at is not null
     and la.email = p.email;

  with gone as (
    delete from auth.users u
     using public.profiles p
     where p.id = u.id
       and p.deletion_requested_at is not null
    returning u.id
  )
  select count(*)::int into v_count from gone;

  return v_count;
end;
$$;

-- Only the scheduled job (and the postgres owner) may run it. Supabase grants new functions to
-- anon and authenticated by default, so revoke from them explicitly.
revoke all on function public.purge_deleted_accounts() from public, anon, authenticated;

-- Every day at 00:17 UTC (02:17 SAST). cron.schedule replaces a job with the same name.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('purge-deleted-accounts', '17 0 * * *', 'select public.purge_deleted_accounts()');
