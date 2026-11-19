// In-app notifications (PRD §4.5, plan §10.1). The D4 trigger (migration report_triggers) inserts one
// when a report is verified: "Thank you! Your update for {store} has been verified. +10 points added."
// RLS only lets a user read their own rows and change only `read_at`, so the browser can call
// Supabase directly. `db` is replaceable for tests.
import { supabase } from '../../lib/supabase.js'

/** The logged-in user's unread notifications, newest first. */
export async function fetchUnreadNotifications(db = supabase) {
  if (!db) return []
  const { data, error } = await db
    .from('notifications')
    .select('id, body, link_to, created_at')
    .is('read_at', null)
    .order('created_at', { ascending: false })
    .limit(10)
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function markNotificationsRead(ids, db = supabase, now = new Date()) {
  if (!db || ids.length === 0) return
  const { error } = await db.from('notifications').update({ read_at: now.toISOString() }).in('id', ids)
  if (error) throw new Error(error.message)
}
