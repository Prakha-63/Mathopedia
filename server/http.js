/* Shared route plumbing. This existed as three byte-identical copies in
   auth.js, admin.js and articles.js, each of which forwarded the raw exception
   message to the client — including SQLite errors naming tables and columns. */

/* Wraps a route so a thrown error becomes one logged response instead of an
   unhandled rejection or an Express stack-trace page.

   The handler is awaited inside try/catch rather than wrapped in
   Promise.resolve(fn(...)).catch(...), which was the original shape and only
   ever caught async rejections: a synchronous throw happens while the argument
   to Promise.resolve is being evaluated, before .catch is attached, so it
   escaped the wrapper entirely. Most routes here are synchronous.

   The client is told only that something failed. The cause goes to the server
   log, where it is useful and not an information leak. A route that wants to
   explain a failure returns its own status and message, as they all do for the
   cases they anticipate. */
export const ok = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (res.headersSent) return;
    /* A route inside a transaction cannot return a response — it has to throw
       to roll back. badRequest() marks such a throw as the caller's fault, so
       the real explanation survives instead of becoming a generic 500. */
    if (e && e.status >= 400 && e.status < 500)
      return res.status(e.status).json({ error: e.message });
    console.error(`[${req.method} ${req.originalUrl}]`, e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

/* throw badRequest('...') to abort a transaction with a 400 the user can act on */
export function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}
