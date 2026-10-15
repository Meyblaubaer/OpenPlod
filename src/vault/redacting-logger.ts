import type { MiddlewareHandler } from 'hono';

/**
 * REL-06: request logger that never prints credentials. Replaces `hono/logger`,
 * which logs the full URL including query strings. Secret-looking query parameters
 * are replaced with `[redacted]`, as are token-like path segments after `/pair/`,
 * `/token/` and similar. Headers and bodies are never logged.
 */
const SECRET_PARAMETER = /^(token|access_token|refresh_token|id_token|api[_-]?key|apikey|key|secret|client_secret|password|passphrase|signature|sig|code|auth|authorization|pairing[_-]?token|session)$/i;
const SECRET_PATH_PARENT = /^(pair|pairing|token|tokens|invite|invites|secret|keys?)$/i;
const LONG_OPAQUE_PATTERN = /^[A-Za-z0-9_\-+/=.]{32,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_OPAQUE = { test: (value: string) => !UUID.test(value) && LONG_OPAQUE_PATTERN.test(value) };

export function redactUrl(input: string): string {
  let url: URL;
  try { url = new URL(input, 'http://local'); } catch { return '[unparseable url]'; }
  const segments = url.pathname.split('/');
  const path = segments.map((segment, index) => (index > 0 && SECRET_PATH_PARENT.test(segments[index - 1] ?? '') && segment) || LONG_OPAQUE.test(segment) ? '[redacted]' : segment).join('/');
  const query = [...url.searchParams.entries()].map(([name, value]) =>
    `${encodeURIComponent(name)}=${SECRET_PARAMETER.test(name) || LONG_OPAQUE.test(value) ? '[redacted]' : encodeURIComponent(value)}`);
  return query.length ? `${path}?${query.join('&')}` : path;
}

export function redactingLogger(print: (line: string) => void = console.log): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    const target = redactUrl(c.req.url);
    print(`<-- ${c.req.method} ${target}`);
    await next();
    print(`--> ${c.req.method} ${target} ${c.res.status} ${Math.round(performance.now() - started)}ms`);
  };
}
