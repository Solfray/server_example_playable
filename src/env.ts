// Bindings and configuration the Worker receives. Mirrors wrangler.jsonc.

export interface Env {
  /** Static files from ./public (wrangler.jsonc "assets"). */
  ASSETS: Fetcher;
  /** Users and maps. */
  DB: D1Database;
  /** Standalone multiplayer rooms (src/room.ts). */
  ROOMS: DurableObjectNamespace;

  /** https://solfray.com unless you run a Solfray-compatible host. */
  SOLFRAY_ORIGIN: string;

  /** Google OAuth client id (public). Empty disables Google sign-in. */
  GOOGLE_CLIENT_ID: string;
  /** Google OAuth client secret (wrangler secret). */
  GOOGLE_CLIENT_SECRET?: string;
  /** HMAC key for the standalone session cookie (wrangler secret). */
  SESSION_SECRET?: string;
}
