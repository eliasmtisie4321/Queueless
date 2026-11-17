import { test } from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/app.js'

// The real app, as Vercel and `npm run dev` run it: private routes must not answer without a token.
async function withServer(run) {
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('GET /api/me/savings is 401 without a token', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/me/savings`)
    assert.equal(res.status, 401)
    assert.equal((await res.json()).code, 'UNAUTHORIZED')
  })
})

test('GET /api/me/savings is 401 for a made-up token (or 500 if Supabase is down), never 200', async () => {
  const original = console.error
  console.error = () => {}
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/me/savings`, { headers: { Authorization: 'Bearer not.a.real.token' } })
      assert.ok([401, 500].includes(res.status), `got ${res.status}`)
    })
  } finally {
    console.error = original
  }
})

test('the public health route still needs no token', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/health`)).status, 200)
  })
})
