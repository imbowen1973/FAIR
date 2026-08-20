// Signing in to GitHub from a page with no server behind it.
//
// GitHub's OAuth endpoints on github.com send no CORS headers — verified,
// not assumed — so a browser cannot exchange a code for a token however
// the flow is started. Exactly one piece of infrastructure is therefore
// unavoidable: a broker that holds the client secret and does only that
// exchange. It never sees repo content; everything after sign-in is
// browser-direct to api.github.com.
//
// Two providers behind one interface:
//
//   token()  -> a GitHub token, or null
//
// - `broker`: real OAuth, needs BROKER_URL configured (config.js).
// - `pat`:    a fine-grained token the user pastes. Zero infrastructure,
//             so the workbench is usable before any broker exists.
//
// The token is held in sessionStorage, never localStorage: it dies with
// the tab rather than sitting on disk until someone clears it.

const TOKEN_KEY = "fair.wb.token";
const LOGIN_KEY = "fair.wb.login";

function remember(token, login) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    if (login) sessionStorage.setItem(LOGIN_KEY, login);
  } catch {
    /* private mode: the session still works, it just will not survive reload */
  }
}

export function storedToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storedLogin() {
  try {
    return sessionStorage.getItem(LOGIN_KEY);
  } catch {
    return null;
  }
}

export function signOut() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(LOGIN_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** A pasted fine-grained PAT. Validated by using it, not by shape. */
export const patProvider = {
  id: "pat",
  label: "Paste a token",
  available: () => true,
  async signIn(token) {
    if (!token || !token.trim()) throw new Error("no token given");
    const clean = token.trim();
    // Prove it works before storing it, so a bad paste fails here rather
    // than as a confusing 401 three screens later.
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${clean}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? "GitHub rejected that token"
          : `could not verify the token (${res.status})`
      );
    }
    const user = await res.json();
    remember(clean, user.login);
    return { token: clean, login: user.login };
  },
};

/**
 * Real OAuth via a broker. The browser sends the user to GitHub, GitHub
 * redirects back with a code, and the broker turns that code into a token.
 */
export function brokerProvider(brokerUrl, clientId) {
  return {
    id: "broker",
    label: "Sign in with GitHub",
    available: () => Boolean(brokerUrl && clientId),

    /** Step 1: leave for GitHub. */
    start(scope = "repo") {
      const state = crypto.randomUUID();
      sessionStorage.setItem("fair.wb.state", state);
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: location.origin + location.pathname,
        scope,
        state,
      });
      location.assign(`https://github.com/login/oauth/authorize?${params}`);
    },

    /** Step 2: on return, swap the code for a token via the broker. */
    async complete() {
      const url = new URL(location.href);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code) return null;

      const expected = sessionStorage.getItem("fair.wb.state");
      // Without this check a third party could hand the user a crafted
      // callback and have their token minted against someone else's flow.
      if (!state || state !== expected) {
        throw new Error("sign-in state did not match — start again");
      }
      sessionStorage.removeItem("fair.wb.state");

      const res = await fetch(brokerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) throw new Error(`the sign-in broker failed (${res.status})`);
      const data = await res.json();
      if (!data.access_token) throw new Error(data.error || "no token returned");

      // Drop the code from the address bar so a reload cannot replay it.
      history.replaceState({}, "", location.pathname);

      const who = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${data.access_token}` },
      }).then((r) => r.json());
      remember(data.access_token, who.login);
      return { token: data.access_token, login: who.login };
    },
  };
}
