import { useEffect, useRef } from 'react'
import { useAuth } from './useAuth.js'
import { getBasket, subscribeBasket } from '../lib/basketStore.js'
import { clearOnLogOut, saveAccountBasket, syncOnLogIn } from '../lib/basketSync.js'
import { supabase } from '../lib/supabase.js'

const SAVE_DELAY_MS = 500

// The latest account basket id, after any save in progress. S4 waits for it before recording a saving.
let ready = Promise.resolve(null)
export const accountBasketReady = () => ready

/**
 * Mounted once (AppShell). While someone is logged in, their basket is kept in their account;
 * on log-out the browser copy is cleared. Guests (or no Supabase) keep the localStorage basket only.
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
    let timer
    let synced = false
    const keepId = (lastId) => (error) => {
      console.warn(`[basket] could not save the basket to the account: ${error.message}`)
      return lastId
    }

    ready = syncOnLogIn(supabase, userId)
      .then((id) => {
        synced = true
        return id
      })
      .catch(keepId(null))

    const unsubscribe = subscribeBasket(() => {
      if (!synced || cancelled) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        ready = ready.then((id) => saveAccountBasket(supabase, userId, id, getBasket()).catch(keepId(id)))
      }, SAVE_DELAY_MS)
    })

    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe()
    }
  }, [userId, loading])
}
