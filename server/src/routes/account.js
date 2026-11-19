// POST /api/account/delete (#20): the "Delete account" dialog on S6 calls this.
// It only marks the profile. The daily pg_cron job `purge-deleted-accounts`
// (migration account_deletion) then deletes the account and its data, within the 7 days the PRD allows.
// The client logs the user out straight after (client/src/screens/refilwe/savingsApi.js).
//
// The log-in check (requireUser, #14) is passed in from server/src/app.js, so tests can pass a fake.
import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const SERVER_ERROR = 'Something went wrong. Try again.' // client/src/lib/messages.js serverError

/**
 * Sets profiles.deletion_requested_at for one user. Asking twice keeps the first time.
 * The server uses the service role (no RLS), so the update is filtered to `userId` here.
 */
export async function markForDeletion(db, userId, now = new Date()) {
  const { error } = await db
    .from('profiles')
    .update({ deletion_requested_at: now.toISOString() })
    .eq('id', userId)
    .is('deletion_requested_at', null)
  if (error) throw new Error(error.message)
}

async function markInSupabase(userId) {
  if (!supabase) throw new Error('Supabase is not configured on the server')
  return markForDeletion(supabase, userId)
}

/**
 * @param {{ requireUser: import('express').RequestHandler,
 *   markDeletion?: (userId: string) => Promise<void> }} deps
 *   requireUser must set req.user.id or answer 401 itself. markDeletion is replaceable for tests.
 */
export function createAccountRouter({ requireUser, markDeletion = markInSupabase }) {
  const router = Router()
  router.post('/account/delete', requireUser, async (req, res) => {
    try {
      await markDeletion(req.user.id)
      res.json({ status: 'scheduled' })
    } catch (error) {
      console.error(`[account] delete for user ${req.user.id}: ${error.message}`)
      res.status(500).json({ error: SERVER_ERROR })
    }
  })
  return router
}
