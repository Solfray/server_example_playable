// api.js: calls to our own Worker, with the right identity attached.
//
// SOLFRAY TIE-IN (guide 7a). When the page runs inside Solfray, every API
// call carries `Authorization: Bearer <playable token>`. The token comes from
// `sf.token()`: the SDK asks the Solfray host, the host asks solfray.com with
// the player's real session, and solfray.com signs a five-minute JWT saying
// "this wallet is in this thread right now, and this token is for <our
// origin>". The Worker verifies that signature against solfray.com's public
// key (src/auth/solfray.ts) and treats `sub` as the player's identity.
//
// The page never sees a private key, never sees a Solfray session cookie, and
// never tells the server who it is in words: it only forwards proof. When the
// page is opened on its own there is no Solfray host, `sf.token()` rejects
// with "unhosted", and identity is the Google session cookie instead, which
// the browser attaches by itself.

export class Api {
  constructor() {
    this.sf = null;
    this._jwt = null;
    this._jwtExp = 0;
  }

  /** Give the API the Solfray session once connect() resolved. */
  setSolfray(sf) {
    this.sf = sf && sf.hosted ? sf : null;
  }

  /** The current playable token, refreshed ~30 s before it expires. */
  async token() {
    if (!this.sf) return null;
    const now = Date.now();
    if (this._jwt && now < this._jwtExp - 30_000) return this._jwt;
    try {
      const jwt = await this.sf.token(); // rejects: "unhosted", "token_unavailable"
      // Read `exp` from the payload for the cache. Not verified here: the
      // page is not the party that needs to trust it, the server is.
      const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      this._jwt = jwt;
      this._jwtExp = (payload.exp || 0) * 1000;
      return jwt;
    } catch (e) {
      console.warn("[rift-builder] no playable token:", e && e.message);
      return null;
    }
  }

  async headers(json) {
    const h = { "X-Requested-With": "rift-builder" };
    if (json) h["Content-Type"] = "application/json";
    const jwt = await this.token();
    if (jwt) h.Authorization = "Bearer " + jwt;
    return h;
  }

  async call(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: await this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      // Same-origin cookies (Google session) ride along on the standalone
      // site; inside Solfray's cross-site frame the browser withholds them
      // and the Bearer header does the work.
      credentials: "same-origin",
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      const err = new Error((data && (data.detail || data.error)) || `http_${res.status}`);
      err.code = data && data.error;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  me() {
    return this.call("GET", "/api/me");
  }
  listMaps(scope) {
    return this.call("GET", `/api/maps?scope=${encodeURIComponent(scope)}`);
  }
  getMap(id) {
    return this.call("GET", `/api/maps/${encodeURIComponent(id)}`);
  }
  createMap(map) {
    return this.call("POST", "/api/maps", map);
  }
  updateMap(id, patch) {
    return this.call("PUT", `/api/maps/${encodeURIComponent(id)}`, patch);
  }
  deleteMap(id) {
    return this.call("DELETE", `/api/maps/${encodeURIComponent(id)}`);
  }
  bumpPlay(id) {
    return this.call("POST", `/api/maps/${encodeURIComponent(id)}/play`, {}).catch(() => {});
  }
  logout() {
    return fetch("/auth/logout", { method: "POST", headers: { "X-Requested-With": "rift-builder" } });
  }
}
