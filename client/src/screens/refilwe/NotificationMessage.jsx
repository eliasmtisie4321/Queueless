/**
 * The verified-report text as the S6 Stitch board shows it: "Thank you!" and "+10 points" in bold.
 * Any other text is shown as it is.
 */
export function NotificationMessage({ body, more = 0 }) {
  const parts = String(body).split(/(Thank you!|\+\d+ points)/)
  return (
    <>
      {parts.map((part, i) => (/^(Thank you!|\+\d+ points)$/.test(part) ? <strong key={i}>{part}</strong> : part))}
      {more > 0 && ` (+${more} more)`}
    </>
  )
}
