// POST /api/account/delete (#20): the "Delete account" dialog on S6 calls this.
// Usually it only marks the profile. The daily pg_cron job `purge-deleted-accounts`
// (migration account_deletion) then deletes the account and its data, within the 7 days the PRD allows.
// A user with no profile row is never found by that job, so they are deleted straight away
// (found in review of #47). The client logs the user out straight after (screens/refilwe/savingsApi.js).
//
// The log-in check (requireUser, #14) is passed in from server/src/app.js, so tests can pass a fake.
import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const SERVER_ERROR = 'Something went wrong. Try again.' // client/src/lib/messages.js serverError

/**
 * Asks for the account to be deleted. Resolves what happened:
 *  - 'scheduled': the profile is marked (now, or by an earlier request: asking twice keeps the first time)
 *  - 'deleted':   there was no profile, so the purge job would never find them. Without a profile they
 *                 can't have baskets, savings or reports, so the auth user and their login_attempts go now.
 * The server uses the service role (no RLS), so every query is filtered to this user here.
 * @param {{ id: string, email?: string }} user  as set by requireUser
 */
export async function requestDeletion(db, user, now = new Date()) {
  const marked = await db
    .from('profiles')
    .update({ deletion_requested_at: now.toISOString() })
    .eq('id', user.id)
    .is('deletion_requested_at', null)
    .select('id')
  if (marked.error) throw new Error(marked.error.message)
  if (marked.data?.length > 0) return 'scheduled'

  // Nothing updated: either it was already marked, or there is no profile at all.
  const existing = await db.from('profiles').select('id').eq('id', user.id).maybeSingle()
  if (existing.error) throw new Error(existing.error.message)
  if (existing.data) return 'scheduled'

  if (user.email) {
    const attempts = await db.from('login_attempts').delete().eq('email', user.email.toLowerCase())
    if (attempts.error) throw new Error(attempts.error.message)
  }
  const { error } = await db.auth.admin.deleteUser(user.id)
  if (error) throw new Error(error.message)
  return 'deleted'
}

async function requestInSupabase(user) {
  if (!supabase) throw new Error('Supabase is not configured on the server')
  return requestDeletion(supabase, user)
}

/**
 * @param {{ requireUser: import('express').RequestHandler,
 *   requestDelete?: (user: { id: string, email?: string }) => Promise<'scheduled'|'deleted'> }} deps
 *   requireUser must set req.user or answer 401 itself. requestDelete is replaceable for tests.
 */
export function createAccountRouter({ requireUser, requestDelete = requestInSupabase }) {
  const router = Router()
  router.post('/account/delete', requireUser, async (req, res) => {
    try {
      res.json({ status: await requestDelete(req.user) })
    } catch (error) {
      console.error(`[account] delete for user ${req.user.id}: ${error.message}`)
      res.status(500).json({ error: SERVER_ERROR })
    }
  })
  return router
}
