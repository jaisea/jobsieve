/**
 * Which addresses may load inside the app window.
 *
 * The window shows the local report and nothing else. Every job posting, company
 * page and source link in it belongs in your browser — where your logins are —
 * so anything that is not this app's own address is handed to the browser, and
 * anything that is not a web address at all is refused. The report is built from
 * text written by job boards, so "whatever a link says" is not a safe thing to
 * load into a window.
 */
export function classify(rawUrl, port) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'blocked';
  }
  if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) === Number(port)) return 'internal';
  if (u.protocol === 'http:' || u.protocol === 'https:') return 'external';
  return 'blocked';
}
