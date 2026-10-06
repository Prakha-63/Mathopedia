/* Shared route plumbing. This existed as three byte-identical copies in
   auth.js, admin.js and articles.js, each of which forwarded the raw exception
   message to the client — including SQLite errors naming tables and columns. */

/* Wraps a route so a thrown error (sync or async) becomes one logged 500
   instead of an unhandled rejection that hangs the request.

   The client is told only that something failed. The cause goes to the server
   log, where it is useful and not an information leak. A route that wants to
   explain a failure should return its own status and message, as they all do
   for the cases they anticipate. */
export const ok = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error(`[${req.method} ${req.originalUrl}]`, e);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
});
