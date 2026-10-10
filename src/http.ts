// Small HTTP helpers: JSON responses, CORS for the API, cookies.

/** CORS headers for /api/*.
 *
 *  SOLFRAY TIE-IN: when this page runs inside Solfray, Solfray frames it in a
 *  sandboxed iframe. For a page on its own host the sandbox keeps
 *  allow-same-origin, so fetches to our own /api arrive with our origin, but
 *  Solfray-hosted (playables.party) pages run with an opaque origin and send
 *  `Origin: null`. Allowing `*` here costs nothing because we never set
 *  Access-Control-Allow-Credentials: a cross-origin caller can present a
 *  playable token in the Authorization header, but the browser will never
 *  attach our session cookie to a cross-origin request. Cookie identity is
 *  therefore reachable only from our own origin (see auth/identity.ts). */
export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS, ...extra },
  });
}

export function error(code: string, status: number, detail?: string): Response {
  return json(detail ? { error: code, detail } : { error: code }, status);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.get("Cookie");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeS: number, secure: boolean): string {
  // HttpOnly + SameSite=Lax: JavaScript never reads it, and a cross-site
  // page (Solfray's iframe included) never sends it. Identity inside
  // Solfray comes from the playable token instead. `secure` is false only on
  // http://localhost during `wrangler dev`.
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=/`,
    `Max-Age=${maxAgeS}`,
    `HttpOnly`,
    `SameSite=Lax`,
    secure ? `Secure` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export async function readJson<T>(req: Request, maxBytes: number): Promise<T | null> {
  const len = Number(req.headers.get("Content-Length") || "0");
  if (len > maxBytes) return null;
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function isHttps(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}
