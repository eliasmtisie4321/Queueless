import { getBasket, saveBasket } from '../basketStore.js'
import {
  OWNER_KEY,
  clearOnLogOut,
  loadAccountBasket,
  recordBasketSaving,
  saveAccountBasket,
  syncOnLogIn,
} from '../basketSync.js'

const MILK = '11111111-0000-4000-8000-000000000001'
const BREAD = '11111111-0000-4000-8000-000000000002'
const SUGAR = '11111111-0000-4000-8000-000000000003'

/**
 * A tiny in-memory stand-in for the Supabase tables the basket uses (baskets, basket_items),
 * with RLS-like behaviour left out: these tests are about what the client sends.
 */
function fakeDb({ baskets = [], items = [] } = {}) {
  const db = { baskets: [...baskets], items: [...items], rpcCalls: [], nextId: 1 }

  db.from = (table) => {
    const filters = []
    let op = 'select'
    let payload
    const matches = (row) =>
      filters.every(([kind, col, val]) =>
        kind === 'eq' ? row[col] === val : !val.includes(row[col]),
      )
    const run = () => {
      const rows = table === 'baskets' ? db.baskets : db.items
      if (op === 'select') {
        const found = rows.filter(matches).map((b) => ({
          ...b,
          basket_items: db.items.filter((i) => i.basket_id === b.id),
        }))
        return { data: found[0] ?? null, error: null }
      }
      if (op === 'insert') {
        const row = { id: `basket-${db.nextId++}`, is_active: true, ...payload }
        db.baskets.push(row)
        return { data: { id: row.id }, error: null }
      }
      if (op === 'update') {
        rows.filter(matches).forEach((r) => Object.assign(r, payload))
        return { error: null }
      }
      if (op === 'delete') {
        db.items = db.items.filter((r) => !matches(r))
        return { error: null }
      }
      if (op === 'upsert') {
        for (const row of payload) {
          const existing = db.items.find((i) => i.basket_id === row.basket_id && i.product_id === row.product_id)
          if (existing) existing.quantity = row.quantity
          else db.items.push({ ...row })
        }
        return { error: null }
      }
      throw new Error(`unexpected ${op}`)
    }
    const chain = {
      select: () => chain,
      insert: (row) => ((op = 'insert'), (payload = row), chain),
      update: (values) => ((op = 'update'), (payload = values), chain),
      delete: () => ((op = 'delete'), chain),
      upsert: (rows) => ((op = 'upsert'), (payload = rows), chain),
      eq: (col, val) => (filters.push(['eq', col, val]), chain),
      not: (col, _in, list) => (filters.push(['notIn', col, list.slice(1, -1).split(',')]), chain),
      maybeSingle: () => chain,
      single: () => chain,
      then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
    }
    return chain
  }
  db.rpc = async (name, args) => {
    db.rpcCalls.push([name, args])
    return { data: 400, error: null }
  }
  return db
}

const itemsOf = (db, basketId) =>
  db.items
    .filter((i) => i.basket_id === basketId)
    .map((i) => [i.product_id, i.quantity])
    .sort()

beforeEach(() => localStorage.clear())

describe('saving to the account', () => {
  test('creates the active basket the first time, with its items', async () => {
    const db = fakeDb()
    const id = await saveAccountBasket(db, 'u1', null, {
      title: 'Weekly shop',
      items: [{ productId: MILK, quantity: 2 }],
    })

    expect(db.baskets).toEqual([expect.objectContaining({ id, user_id: 'u1', title: 'Weekly shop' })])
    expect(itemsOf(db, id)).toEqual([[MILK, 2]])
  })

  test('later saves update quantities and drop removed items', async () => {
    const db = fakeDb({
      baskets: [{ id: 'b1', user_id: 'u1', title: 'My basket', is_active: true }],
      items: [
        { basket_id: 'b1', product_id: MILK, quantity: 1 },
        { basket_id: 'b1', product_id: BREAD, quantity: 1 },
      ],
    })
    await saveAccountBasket(db, 'u1', 'b1', { title: 'Renamed', items: [{ productId: MILK, quantity: 3 }] })

    expect(itemsOf(db, 'b1')).toEqual([[MILK, 3]])
    expect(db.baskets[0].title).toBe('Renamed')
  })

  test('an emptied basket removes every item', async () => {
    const db = fakeDb({
      baskets: [{ id: 'b1', user_id: 'u1', title: 'My basket', is_active: true }],
      items: [{ basket_id: 'b1', product_id: MILK, quantity: 1 }],
    })
    await saveAccountBasket(db, 'u1', 'b1', { title: 'My basket', items: [] })
    expect(itemsOf(db, 'b1')).toEqual([])
  })

  test('development sample products are never sent to the database', async () => {
    const db = fakeDb()
    const id = await saveAccountBasket(db, 'u1', null, {
      title: 'My basket',
      items: [
        { productId: 'sample-milk', quantity: 1 },
        { productId: BREAD, quantity: 1 },
      ],
    })
    expect(itemsOf(db, id)).toEqual([[BREAD, 1]])
  })

  test('loads the active basket with its items, or null when there is none', async () => {
    const db = fakeDb({
      baskets: [{ id: 'b1', user_id: 'u1', title: 'My basket', is_active: true }],
      items: [{ basket_id: 'b1', product_id: MILK, quantity: 2 }],
    })
    await expect(loadAccountBasket(db, 'u1')).resolves.toEqual({
      id: 'b1',
      title: 'My basket',
      items: [{ productId: MILK, quantity: 2 }],
    })
    await expect(loadAccountBasket(db, 'u2')).resolves.toBeNull()
  })
})

describe('on log-in (plan §4.3)', () => {
  test('a guest basket is added into the account basket, quantities added', async () => {
    const db = fakeDb({
      baskets: [{ id: 'b1', user_id: 'u1', title: 'Weekly shop', is_active: true }],
      items: [{ basket_id: 'b1', product_id: MILK, quantity: 1 }],
    })
    saveBasket({ title: 'My basket', items: [{ productId: MILK, quantity: 2 }, { productId: SUGAR, quantity: 1 }] })

    await expect(syncOnLogIn(db, 'u1')).resolves.toBe('b1')

    expect(itemsOf(db, 'b1')).toEqual([[MILK, 3], [SUGAR, 1]])
    expect(getBasket()).toEqual({
      title: 'Weekly shop',
      items: [{ productId: MILK, quantity: 3 }, { productId: SUGAR, quantity: 1 }],
    })
    expect(localStorage.getItem(OWNER_KEY)).toBe('u1')
  })

  test('a guest with no account basket yet: the guest basket becomes the account basket', async () => {
    const db = fakeDb()
    saveBasket({ title: 'My basket', items: [{ productId: BREAD, quantity: 1 }] })

    const id = await syncOnLogIn(db, 'u1')

    expect(itemsOf(db, id)).toEqual([[BREAD, 1]])
  })

  test('refreshing the page does not add the same basket twice', async () => {
    const db = fakeDb()
    saveBasket({ title: 'My basket', items: [{ productId: BREAD, quantity: 1 }] })
    const id = await syncOnLogIn(db, 'u1')
    await syncOnLogIn(db, 'u1') // next page load, same user

    expect(itemsOf(db, id)).toEqual([[BREAD, 1]])
    expect(getBasket().items).toEqual([{ productId: BREAD, quantity: 1 }])
  })

  test('another person\'s basket left in this browser is never mixed in', async () => {
    const db = fakeDb({
      baskets: [{ id: 'b2', user_id: 'u2', title: 'Mine', is_active: true }],
      items: [{ basket_id: 'b2', product_id: SUGAR, quantity: 1 }],
    })
    saveBasket({ title: 'Theirs', items: [{ productId: MILK, quantity: 5 }] })
    localStorage.setItem(OWNER_KEY, 'u1')

    await syncOnLogIn(db, 'u2')

    expect(itemsOf(db, 'b2')).toEqual([[SUGAR, 1]])
    expect(getBasket()).toEqual({ title: 'Mine', items: [{ productId: SUGAR, quantity: 1 }] })
  })
})

test('log out clears the browser basket and who it belonged to', () => {
  saveBasket({ title: 'Weekly shop', items: [{ productId: MILK, quantity: 1 }] })
  localStorage.setItem(OWNER_KEY, 'u1')

  clearOnLogOut()

  expect(getBasket().items).toEqual([])
  expect(localStorage.getItem(OWNER_KEY)).toBeNull()
})

test('recording a saving calls record_basket_saving with the basket id', async () => {
  const db = fakeDb()
  await recordBasketSaving(db, 'b1')
  expect(db.rpcCalls).toEqual([['record_basket_saving', { p_basket_id: 'b1' }]])
})
