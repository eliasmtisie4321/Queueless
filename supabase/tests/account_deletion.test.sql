-- #20 Delete account tests (pgTAP). Run with: npm run db:test
-- Everything runs in one transaction and is rolled back, so the shared database is left unchanged.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

-- ── Test data ───────────────────────────────────────────────────────────────────────────
-- User 301 asks to delete their account, user 302 doesn't.
insert into auth.users (id, email, email_confirmed_at) values
  ('aaaaaaaa-0000-4000-8000-000000000301', 'delete.me@queueless.test', now()),
  ('aaaaaaaa-0000-4000-8000-000000000302', 'keep.me@queueless.test', now());
insert into public.profiles (id, email, is_16_or_older, privacy_consent_at) values
  ('aaaaaaaa-0000-4000-8000-000000000301', 'delete.me@queueless.test', true, now()),
  ('aaaaaaaa-0000-4000-8000-000000000302', 'keep.me@queueless.test', true, now());
insert into public.suburbs (id, name, city) values ('bbbbbbbb-0000-4000-8000-000000000301', 'Delete Suburb', 'Test City');
insert into public.stores (id, name, suburb_id, address, opening_hours) values
  ('cccccccc-0000-4000-8000-000000000301', 'Delete Store', 'bbbbbbbb-0000-4000-8000-000000000301', 'Test', '08:00–20:00');

insert into public.baskets (id, user_id) values
  ('dddddddd-0000-4000-8000-000000000301', 'aaaaaaaa-0000-4000-8000-000000000301'),
  ('dddddddd-0000-4000-8000-000000000302', 'aaaaaaaa-0000-4000-8000-000000000302');
insert into public.savings_events (user_id, basket_id, store_id, amount_cents) values
  ('aaaaaaaa-0000-4000-8000-000000000301', 'dddddddd-0000-4000-8000-000000000301', 'cccccccc-0000-4000-8000-000000000301', 400),
  ('aaaaaaaa-0000-4000-8000-000000000302', 'dddddddd-0000-4000-8000-000000000302', 'cccccccc-0000-4000-8000-000000000301', 400);
insert into public.report_logs (id, user_id, store_id, report_type, submitted_value) values
  ('ffffffff-0000-4000-8000-000000000301', 'aaaaaaaa-0000-4000-8000-000000000301', 'cccccccc-0000-4000-8000-000000000301', 'Queue', 'short');
insert into public.login_attempts (email) values ('delete.me@queueless.test'), ('keep.me@queueless.test');

-- ── Who can mark and purge ──────────────────────────────────────────────────────────────
select has_column('public', 'profiles', 'deletion_requested_at', 'profiles has deletion_requested_at');

select is(has_function_privilege('anon', 'public.purge_deleted_accounts()', 'execute'), false,
  'anon cannot run purge_deleted_accounts');
select is(has_function_privilege('authenticated', 'public.purge_deleted_accounts()', 'execute'), false,
  'authenticated cannot run purge_deleted_accounts');

set local role authenticated;
set local request.jwt.claims = '{"sub": "aaaaaaaa-0000-4000-8000-000000000302", "role": "authenticated"}';
select throws_ok(
  $$ update public.profiles set deletion_requested_at = null where id = 'aaaaaaaa-0000-4000-8000-000000000302' $$,
  '42501', null,
  'A user cannot set or clear deletion_requested_at themselves (server only)'
);
reset role;

select isnt((select jobid from cron.job where jobname = 'purge-deleted-accounts'), null,
  'The daily purge job is scheduled');
select is((select schedule from cron.job where jobname = 'purge-deleted-accounts'), '17 0 * * *',
  'It runs once a day');

-- ── Nothing marked: nothing deleted ─────────────────────────────────────────────────────
select is(public.purge_deleted_accounts(), 0, 'With no account marked, nothing is deleted');

-- ── Mark user 301 (what POST /api/account/delete does) and run the job ──────────────────
update public.profiles set deletion_requested_at = now() where id = 'aaaaaaaa-0000-4000-8000-000000000301';

select is(public.purge_deleted_accounts(), 1, 'The purge deletes the one marked account');

select is((select count(*)::int from auth.users where id = 'aaaaaaaa-0000-4000-8000-000000000301'), 0,
  'The marked auth user is gone');
select is((select count(*)::int from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000301'), 0,
  'Their profile is gone');
select is(
  (select count(*)::int from public.baskets where user_id = 'aaaaaaaa-0000-4000-8000-000000000301')
  + (select count(*)::int from public.savings_events where user_id = 'aaaaaaaa-0000-4000-8000-000000000301'),
  0, 'Their saved baskets and savings are gone');
select is((select count(*)::int from public.login_attempts where email = 'delete.me@queueless.test'), 0,
  'Their login attempts (email logs) are gone');
select is((select user_id from public.report_logs where id = 'ffffffff-0000-4000-8000-000000000301'), null,
  'Their reports stay for store data but no longer point to them');

select is(
  (select count(*)::int from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000302')
  + (select count(*)::int from public.login_attempts where email = 'keep.me@queueless.test')
  + (select count(*)::int from public.savings_events where user_id = 'aaaaaaaa-0000-4000-8000-000000000302'),
  3, 'Other users are untouched');

select * from finish();
rollback;
