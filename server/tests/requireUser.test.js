import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createRequireUser, readBearerToken } from '../src/middleware/requireUser.js'

// ── readBearerToken

test('reads the token from "Bearer <token>", ignoring case and extra spaces', () => {
  assert.equal(readBearerToken('Bearer abc.def'), 'abc.def')
  assert.equal(readBearerToken('bearer   abc.def  '), 'abc.def')
})

test('anything that is not "Bearer <token>" gives no token', () => {
  for (const header of [undefined, null, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc.def', 'Bearer a b', 42]) {
    assert.equal(readBearerToken(header), null, `header: ${String(header)}`)
  }
})

// ── the middleware, mounted on a real Express route

const goodUser = { id: 'user-1', email: 'joy@example.com', app_metadata: { role: 'secret' } }

/** Runs a one-route app behind `getUser`; `run(url, calls)` makes the requests. */
async function withApp(getUser, run) {
  const calls = { route: 0, getUser: [] }
  const tracked = getUser && ((token) => (calls.getUser.push(token), getUser(token)))
  const app = express()
  app.get('/private', createRequireUser(tracked), (req, res) => {
    calls.route += 1
    res.json({ user: req.user })
  })
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}/private`, calls)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// Keeps the test output clean: the middleware logs when it answers 500.
function silenceErrors(fn) {
  return async () => {
    const original = console.error
    console.error = () => {}
    try {
      await fn()
    } finally {
      console.error = original
    }
  }
}

test('401 without a token, and the route never runs', async () => {
  await withApp(async () => ({ data: { user: goodUser }, error: null }), async (url, calls) => {
    const res = await fetch(url)
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: 'Not logged in.', code: 'UNAUTHORIZED' })
    assert.equal(calls.route, 0)
    assert.equal(calls.getUser.length, 0, 'no need to ask Supabase when there is no token')
  })
})

test('401 for a header that is not Bearer', async () => {
  await withApp(async () => ({ data: { user: goodUser }, error: null }), async (url, calls) => {
    const res = await fetch(url, { headers: { Authorization: 'Basic dXNlcjpwYXNz' } })
    assert.equal(res.status, 401)
    assert.equal(calls.route, 0)
  })
})

test('401 when Supabase rejects the token (wrong or expired)', async () => {
  const rejected = async () => ({ data: { user: null }, error: { name: 'AuthApiError', status: 401, message: 'invalid JWT' } })
  await withApp(rejected, async (url, calls) => {
    const res = await fetch(url, { headers: { Authorization: 'Bearer expired.token' } })
    assert.equal(res.status, 401)
    assert.equal(calls.route, 0)
    assert.deepEqual(calls.getUser, ['expired.token'])
  })
})

test('401 when Supabase answers with no user and no error', async () => {
  await withApp(async () => ({ data: { user: null }, error: null }), async (url) => {
    const res = await fetch(url, { headers: { Authorization: 'Bearer some.token' } })
    assert.equal(res.status, 401)
  })
})

test('a valid token puts the user on req.user and the route runs', async () => {
  await withApp(async () => ({ data: { user: goodUser }, error: null }), async (url, calls) => {
    const res = await fetch(url, { headers: { Authorization: 'Bearer good.token' } })
    assert.equal(res.status, 200)
    const body = await res.json()
    // Only what routes need: no metadata or tokens leak onto req.user.
    assert.deepEqual(body.user, { id: 'user-1', email: 'joy@example.com' })
    assert.equal(calls.route, 1)
    assert.deepEqual(calls.getUser, ['good.token'])
  })
})

test(
  '500 (not 401) when Supabase cannot be reached, so users are not logged out by an outage',
  silenceErrors(async () => {
    const down = async () => ({ data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' } })
    await withApp(down, async (url, calls) => {
      const res = await fetch(url, { headers: { Authorization: 'Bearer good.token' } })
      assert.equal(res.status, 500)
      assert.deepEqual(await res.json(), { error: 'Something went wrong. Try again.' })
      assert.equal(calls.route, 0)
    })
  }),
)

test(
  '500 when Supabase answers with a server error',
  silenceErrors(async () => {
    const broken = async () => ({ data: { user: null }, error: { name: 'AuthApiError', status: 503, message: 'unavailable' } })
    await withApp(broken, async (url) => {
      const res = await fetch(url, { headers: { Authorization: 'Bearer good.token' } })
      assert.equal(res.status, 500)
    })
  }),
)

test(
  '500 when the check itself throws',
  silenceErrors(async () => {
    await withApp(async () => { throw new Error('boom') }, async (url, calls) => {
      const res = await fetch(url, { headers: { Authorization: 'Bearer good.token' } })
      assert.equal(res.status, 500)
      assert.equal(calls.route, 0)
    })
  }),
)

test(
  '500 when Supabase is not configured, but still 401 without a token',
  silenceErrors(async () => {
    await withApp(null, async (url) => {
      assert.equal((await fetch(url)).status, 401)
      assert.equal((await fetch(url, { headers: { Authorization: 'Bearer good.token' } })).status, 500)
    })
  }),
)

test(
  'the token never appears in the error log',
  silenceErrors(async () => {
    const logged = []
    console.error = (...args) => logged.push(args.join(' '))
    await withApp(async () => { throw new Error('boom') }, async (url) => {
      await fetch(url, { headers: { Authorization: 'Bearer super.secret.token' } })
    })
    assert.ok(logged.length > 0)
    assert.ok(logged.every((line) => !line.includes('super.secret.token')))
  }),
)
