import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createAccountRouter, requestDeletion } from '../src/routes/account.js'

// ── requestDeletion: a small in-memory stand-in for the tables it touches

const NOW = new Date('2026-11-19T10:00:00Z')
const USER = { id: 'user-1', email: 'Shopper.One@example.com' }

function fakeDb({ profiles = [], loginAttempts = [], failOn } = {}) {
  const db = {
    profiles: profiles.map((p) => ({ ...p })),
    loginAttempts: [...loginAttempts],
    deletedUsers: [],
    queries: [],
  }
  db.from = (table) => {
    const q = { table, op: 'select', filters: [] }
    db.queries.push(q)
    const matches = (row) =>
      q.filters.every(([kind, col, val]) => (kind === 'eq' ? row[col] === val : (row[col] ?? null) === val))
    const run = () => {
      if (failOn === table) return { data: null, error: { message: 'boom' } }
      if (table === 'login_attempts') {
        db.loginAttempts = db.loginAttempts.filter((r) => !matches(r))
        return { error: null }
      }
      const rows = db.profiles.filter(matches)
      if (q.op === 'update') {
        rows.forEach((r) => Object.assign(r, q.values))
        return { data: rows.map((r) => ({ id: r.id })), error: null }
      }
      return { data: rows[0] ? { id: rows[0].id } : null, error: null }
    }
    const chain = {
      update: (values) => ((q.op = 'update'), (q.values = values), chain),
      delete: () => ((q.op = 'delete'), chain),
      select: () => chain,
      eq: (col, val) => (q.filters.push(['eq', col, val]), chain),
      is: (col, val) => (q.filters.push(['is', col, val]), chain),
      maybeSingle: () => chain,
      then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
    }
    return chain
  }
  db.auth = {
    admin: {
      deleteUser: async (id) => {
        if (failOn === 'auth') return { error: { message: 'auth down' } }
        db.deletedUsers.push(id)
        return { error: null }
      },
    },
  }
  return db
}

test('a user with a profile is marked with the request time and scheduled, nothing deleted yet', async () => {
  const db = fakeDb({ profiles: [{ id: 'user-1' }, { id: 'user-2' }] })

  assert.equal(await requestDeletion(db, USER, NOW), 'scheduled')

  assert.equal(db.profiles[0].deletion_requested_at, '2026-11-19T10:00:00.000Z')
  assert.equal(db.profiles[1].deletion_requested_at, undefined, 'other users are untouched')
  assert.deepEqual(db.deletedUsers, [])
  assert.deepEqual(db.queries[0].filters[0], ['eq', 'id', 'user-1'], 'the update is filtered to this user')
})

test('asking twice keeps the first request time', async () => {
  const db = fakeDb({ profiles: [{ id: 'user-1', deletion_requested_at: '2026-11-18T08:00:00.000Z' }] })

  assert.equal(await requestDeletion(db, USER, NOW), 'scheduled')

  assert.equal(db.profiles[0].deletion_requested_at, '2026-11-18T08:00:00.000Z')
  assert.deepEqual(db.deletedUsers, [])
})

test('no profile row: the purge job would never find them, so they are deleted straight away (review of #47)', async () => {
  const db = fakeDb({ loginAttempts: [{ email: 'shopper.one@example.com' }, { email: 'someone.else@example.com' }] })

  assert.equal(await requestDeletion(db, USER, NOW), 'deleted')

  assert.deepEqual(db.deletedUsers, ['user-1'])
  assert.deepEqual(db.loginAttempts, [{ email: 'someone.else@example.com' }], 'their login attempts (lowercase email) go too')
})

test('a database error is thrown, not hidden, and nobody is deleted', async () => {
  await assert.rejects(requestDeletion(fakeDb({ failOn: 'profiles' }), USER, NOW), /boom/)
  const db = fakeDb({ failOn: 'auth' })
  await assert.rejects(requestDeletion(db, USER, NOW), /auth down/)
})

// ── POST /api/account/delete, with requireUser passed in

async function call(router) {
  const app = express()
  app.use('/api', router)
  const server = app.listen(0)
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/account/delete`, { method: 'POST' })
    return { status: res.status, body: await res.json() }
  } finally {
    server.close()
  }
}

const letIn = (req, _res, next) => ((req.user = { id: 'user-1', email: 'shopper.one@example.com' }), next())
const keepOut = (_req, res) => res.status(401).json({ error: 'Not logged in.', code: 'UNAUTHORIZED' })

test('without a logged-in user it returns 401 and does nothing', async () => {
  let asked = false
  const res = await call(createAccountRouter({ requireUser: keepOut, requestDelete: async () => ((asked = true), 'scheduled') }))
  assert.equal(res.status, 401)
  assert.equal(asked, false)
})

test('passes the logged-in user and answers with what happened', async () => {
  let askedFor
  const res = await call(
    createAccountRouter({ requireUser: letIn, requestDelete: async (user) => ((askedFor = user), 'deleted') }),
  )
  assert.equal(res.status, 200)
  assert.deepEqual(askedFor, { id: 'user-1', email: 'shopper.one@example.com' })
  assert.deepEqual(res.body, { status: 'deleted' })
})

test('GET is not allowed: deleting needs a POST', async () => {
  const app = express()
  app.use('/api', createAccountRouter({ requireUser: letIn, requestDelete: async () => 'scheduled' }))
  const server = app.listen(0)
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/account/delete`)
    assert.equal(res.status, 404)
  } finally {
    server.close()
  }
})

test('the real app answers POST /api/account/delete with 401 when there is no token', async () => {
  const { default: app } = await import('../src/app.js')
  const server = app.listen(0)
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/account/delete`, { method: 'POST' })
    assert.equal(res.status, 401)
    assert.equal((await res.json()).code, 'UNAUTHORIZED')
  } finally {
    server.close()
  }
})

test('a failure returns the standard message without leaking details', async () => {
  const res = await call(
    createAccountRouter({
      requireUser: letIn,
      requestDelete: async () => {
        throw new Error('column "secret" does not exist')
      },
    }),
  )
  assert.equal(res.status, 500)
  assert.deepEqual(res.body, { error: 'Something went wrong. Try again.' })
})
