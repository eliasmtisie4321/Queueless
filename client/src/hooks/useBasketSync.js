import { useEffect, useRef } from 'react'
import { useAuth } from './useAuth.js'
import { subscribeBasket } from '../lib/basketStore.js'
import {
  clearOnLogOut,
  hasPendingChanges,
  markPendingChanges,
  saveBrowserBasket,
  syncOnLogIn,
} from '../lib/basketSync.js'
import { supabase } from '../lib/supabase.js'

const SAVE_DELAY_MS = 500

// Every account write runs one after another on this chain, so two syncs can never race
// (React StrictMode runs effects twice in development). It resolves the latest account basket id;
// S4 waits for it before recording a saving.
let ready = Promise.resolve(null)
export const accountBasketReady = () => ready

/**
 * Mounted once (AppShell). While someone is logged in, their basket is kept in their account;
 * on log-out the browser copy is cleared. Guests (or no Supabase) keep the localStorage basket only.
 * A failed sync or save is retried on the next change and when the browser comes back online.
 */
export function useBasketSync() {
  const { user, loading } = useAuth()
  const userId = user?.id ?? null
  const wasLoggedIn = useRef(false)

  useEffect(() => {
    if (!supabase || loading) return undefined
    if (!userId) {
      if (wasLoggedIn.current) clearOnLogOut()
      wasLoggedIn.current = false
      ready = Promise.resolve(null)
      return undefined
    }
    wasLoggedIn.current = true

    let cancelled = false
    let synced = false
    let timer

    // Load/merge the account copy first; after that, each run saves the browser copy.
    const run = () => {
      ready = ready.then(async (lastId) => {
        if (cancelled) return lastId
        try {
          if (!synced) {
            const id = await syncOnLogIn(supabase, userId)
            synced = true
            return id
          }
          return await saveBrowserBasket(supabase, userId, lastId)
        } catch (error) {
          console.warn(`[basket] could not save the basket to the account: ${error.message}`)
          return lastId
        }
      })
    }

    run()

    const unsubscribe = subscribeBasket(() => {
      if (cancelled) return
      // Changed before the account copy loaded: make sure the next sync keeps this change.
      if (!synced) markPendingChanges()
      clearTimeout(timer)
      timer = setTimeout(run, SAVE_DELAY_MS)
    })

    const onOnline = () => {
      if (!synced || hasPendingChanges()) run()
    }
    window.addEventListener('online', onOnline)

    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('online', onOnline)
    }
  }, [userId, loading])
}
