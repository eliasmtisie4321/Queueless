// requireUser (#14): checks the log-in token on an API call.
//
// The browser sends `Authorization: Bearer <access token>` (client/src/lib/api.js adds it).
// We ask Supabase Auth who the token belongs to. If it's valid, the user is put on `req.user`
// and the request carries on. Otherwise we answer 401 and the route never runs.
//
// Use it on any route that needs a logged-in user:
//   router.get('/me/savings', requireUser, (req, res) => { ... req.user.id ... })
import { supabase } from '../lib/supabase.js'

const SERVER_ERROR = 'Something went wrong. Try again.' // client/src/lib/messages.js serverError

/** 'Bearer abc.def.ghi' → 'abc.def.ghi'. Anything else (no header, other scheme, empty token) → null. */
export function readBearerToken(header) {
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : null
}

// Supabase answers 4xx when the token is wrong or expired, and 5xx (or a retryable fetch error)
// when it can't be reached. Only the first means "not logged in".
function isServiceFailure(error) {
  return error.name === 'AuthRetryableFetchError' || error.status >= 500 || error.status === 0
}

/**
 * Builds the middleware. `getUser(token)` has the same shape as supabase.auth.getUser,
 * so tests can pass a fake. In the app, use the ready-made `requireUser` below.
 */
export function createRequireUser(getUser) {
  return async function requireUser(req, res, next) {
    const token = readBearerToken(req.get('authorization'))
    if (!token) return res.status(401).json({ error: 'Not logged in.', code: 'UNAUTHORIZED' })

    if (!getUser) {
      console.error('[requireUser] Supabase is not configured on the server, so tokens cannot be checked.')
      return res.status(500).json({ error: SERVER_ERROR })
    }

    try {
      const { data, error } = await getUser(token)
      if (error && isServiceFailure(error)) throw error
      if (error || !data?.user) return res.status(401).json({ error: 'Not logged in.', code: 'UNAUTHORIZED' })

      req.user = { id: data.user.id, email: data.user.email }
      return next()
    } catch (error) {
      // Never log the token itself.
      console.error(`[requireUser] could not check the token: ${error.message}`)
      return res.status(500).json({ error: SERVER_ERROR })
    }
  }
}

export const requireUser = createRequireUser(supabase ? (token) => supabase.auth.getUser(token) : null)

export default requireUser
