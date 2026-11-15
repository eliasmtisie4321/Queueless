// Sends email through Resend (plan §10.1) using Node's built-in fetch, so no extra package is needed.
// Without RESEND_API_KEY (development and tests) it logs the email instead of sending it.

const RESEND_URL = 'https://api.resend.com/emails'

/**
 * @param {{ to: string, subject: string, text: string, html?: string }} message
 * @param {{ apiKey?: string, from?: string, fetch?: typeof fetch, log?: (line: string) => void }} [options]
 *   Defaults come from RESEND_API_KEY and EMAIL_FROM; tests pass their own.
 * @returns {Promise<string|null>} Resend's email id, or null when it only logged.
 */
export async function sendEmail(message, options = {}) {
  const {
    apiKey = process.env.RESEND_API_KEY,
    from = process.env.EMAIL_FROM,
    fetch: doFetch = globalThis.fetch,
    log = console.log,
  } = options

  if (!apiKey) {
    log(`[email] RESEND_API_KEY not set, not sending to ${message.to}: ${message.subject}`)
    return null
  }

  const res = await doFetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  })

  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Resend ${res.status}: ${data?.message ?? 'request failed'}`)
  return data?.id ?? null
}
