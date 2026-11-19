import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createAccountRouter, markForDeletion } from '../src/routes/account.js'

// ── markForDeletion: marks only this user, and only once

function fakeDb(answer = { error: null }) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, filters: [] }
      calls.push(q)
      const chain = {
        update: (values) => ((q.update = values), chain),
        eq: (col, val) => (q.filters.push(['eq', col, val]), chain),
        is: (col, val) => (q.filters.push(['is', col, val]), chain),
        then: (resolve, reject) => Promise.resolve(answer).then(resolve, reject),
      }
      return chain
    },
  }
}

test('marks the user\'s own profile with the request time, and keeps the first request', async () => {
  const db = fakeDb()
  await markForDeletion(db, 'user-1', new Date('2026-11-17T10:00:00Z'))

  assert.equal(db.calls.length, 1)
  const [q] = db.calls
  assert.equal(q.table, 'profiles')
  assert.deepEqual(q.update, { deletion_requested_at: '2026-11-17T10:00:00.000Z' })
  assert.deepEqual(q.filters, [
    ['eq', 'id', 'user-1'],
    ['is', 'deletion_requested_at', null],
  ])
})

test('a database error is thrown, not hidden', async () => {
  await assert.rejects(markForDeletion(fakeDb({ error: { message: 'boom' } }), 'user-1'), /boom/)
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

const letIn = (req, _res, next) => ((req.user = { id: 'user-1' }), next())
const keepOut = (_req, res) => res.status(401).json({ error: 'Not logged in.', code: 'UNAUTHORIZED' })

test('without a logged-in user it returns 401 and marks nothing', async () => {
  let marked = false
  const res = await call(createAccountRouter({ requireUser: keepOut, markDeletion: async () => (marked = true) }))
  assert.equal(res.status, 401)
  assert.equal(marked, false)
})

test('marks the logged-in user and says it is scheduled', async () => {
  let askedFor
  const res = await call(createAccountRouter({ requireUser: letIn, markDeletion: async (id) => (askedFor = id) }))
  assert.equal(res.status, 200)
  assert.equal(askedFor, 'user-1')
  assert.deepEqual(res.body, { status: 'scheduled' })
})

test('GET is not allowed: deleting needs a POST', async () => {
  const app = express()
  app.use('/api', createAccountRouter({ requireUser: letIn, markDeletion: async () => {} }))
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
      markDeletion: async () => {
        throw new Error('column "secret" does not exist')
      },
    }),
  )
  assert.equal(res.status, 500)
  assert.deepEqual(res.body, { error: 'Something went wrong. Try again.' })
})
