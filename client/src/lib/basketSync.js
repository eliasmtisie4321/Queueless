// Keeps a logged-in shopper's basket in their account (`baskets` + `basket_items`, plan §4.3).
// The browser copy (lib/basketStore.js) stays the one every screen reads, so the basket keeps
// working offline; this module copies it to and from Supabase.
//
//   log in   → guest basket: added into the account basket (quantities added), plan §4.3
//              this user's basket: the account copy wins (it may have changed on another device),
//                unless the browser has changes that never reached the account: then those win
//              someone else's basket left in this browser: never mixed in, the account copy is used
//   change   → saved to the account shortly after (debounced by the caller). A failed save
//              (offline, brief error) leaves a "pending" flag, so nothing is lost on reload
//   log out  → the browser copy is cleared, so the next person doesn't see it
//
// Every function takes the Supabase client as `db`, so tests can pass a fake.
import { DEFAULT_TITLE, getBasket, mergeBaskets, saveBasket } from './basketStore.js'

/** Which account the browser basket belongs to. Missing = a guest basket. */
export const OWNER_KEY = 'queueless.basket.owner'
/** Set while the browser basket has changes that never reached the account (review of #49). */
export const PENDING_KEY = 'queueless.basket.pending'

const EMPTY = { title: DEFAULT_TITLE, items: [] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Sample products from development ('sample-…') aren't in the products table, so they can't be saved.
const savableItems = (items) => items.filter((i) => UUID.test(i.productId))

function readOwner() {
  try {
    return localStorage.getItem(OWNER_KEY)
  } catch {
    return null
  }
}

function writeKey(key, value) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // storage blocked (private mode): the basket still works, it just merges again next time
  }
}

const writeOwner = (userId) => writeKey(OWNER_KEY, userId)
const setPending = (pending) => writeKey(PENDING_KEY, pending ? '1' : null)

/** A change made before the account copy could be loaded: keep it on the next sync. */
export const markPendingChanges = () => setPending(true)

/** True while the browser basket has changes the account doesn't have yet. */
export function hasPendingChanges() {
  try {
    return localStorage.getItem(PENDING_KEY) === '1'
  } catch {
    return false
  }
}

/** The user's active basket from Supabase, or null if they don't have one yet. */
export async function loadAccountBasket(db, userId) {
  const { data, error } = await db
    .from('baskets')
    .select('id, title, basket_items(product_id, quantity)')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return {
    id: data.id,
    title: data.title,
    items: (data.basket_items ?? []).map((i) => ({ productId: i.product_id, quantity: i.quantity })),
  }
}

/** Writes `basket` to the account (creating the active basket if needed). Resolves the basket id. */
export async function saveAccountBasket(db, userId, basketId, basket) {
  let id = basketId
  if (id) {
    const { error } = await db
      .from('baskets')
      .update({ title: basket.title, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw new Error(error.message)
  } else {
    const { data, error } = await db.from('baskets').insert({ user_id: userId, title: basket.title }).select('id').single()
    if (error) throw new Error(error.message)
    id = data.id
  }

  const items = savableItems(basket.items)
  let removed = db.from('basket_items').delete().eq('basket_id', id)
  if (items.length > 0) removed = removed.not('product_id', 'in', `(${items.map((i) => i.productId).join(',')})`)
  const { error: removeError } = await removed
  if (removeError) throw new Error(removeError.message)

  if (items.length > 0) {
    const { error } = await db
      .from('basket_items')
      .upsert(items.map((i) => ({ basket_id: id, product_id: i.productId, quantity: i.quantity })))
    if (error) throw new Error(error.message)
  }
  return id
}

/**
 * Saves the current browser basket to the account. If it fails, the pending flag is set, so the
 * next sync keeps the browser copy instead of overwriting it; a success clears it.
 */
export async function saveBrowserBasket(db, userId, basketId) {
  try {
    const id = await saveAccountBasket(db, userId, basketId, getBasket())
    setPending(false)
    return id
  } catch (error) {
    setPending(true)
    throw error
  }
}

/** Runs when a user is logged in (page load, log-in, or a retry). Resolves the account basket id. */
export async function syncOnLogIn(db, userId) {
  const owner = readOwner()
  const local = getBasket()
  const account = await loadAccountBasket(db, userId)

  let next
  if (!owner) next = account ? mergeBaskets(account, local) : local // guest basket: add it in
  else if (owner === userId) next = hasPendingChanges() || !account ? local : account // unsaved edits win
  else next = account ?? EMPTY // never mix in another person's basket

  const id = await saveAccountBasket(db, userId, account?.id, next)
  saveBasket({ title: next.title, items: next.items }) // first: listeners may react to it
  writeOwner(userId)
  setPending(false) // the account now has exactly the browser copy
  return id
}

/** After log-out: clear the browser basket so the next person starts with an empty one. */
export function clearOnLogOut() {
  writeOwner(null)
  setPending(false)
  saveBasket(EMPTY)
}

/**
 * Logs today's saving for S6 (record_basket_saving, migration savings). The database works it out
 * from the saved basket items and logs at most one per day, so calling it again is harmless.
 * It returns the saving even when nothing new was logged, so never show "saving recorded" from it.
 */
export async function recordBasketSaving(db, basketId) {
  const { error } = await db.rpc('record_basket_saving', { p_basket_id: basketId })
  if (error) throw new Error(error.message)
}
