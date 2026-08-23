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
// Where the token is kept is the author's choice, and it is a real one.
//
// sessionStorage dies with the tab: safest, and it means pasting a token
// again every time. localStorage survives a restart, at the cost of the
// token sitting on disk where any script running on this origin could
// read it — which for a static page with no third-party scripts is a
// small risk, but not a zero one.
//
// So: session by default, disk only when asked for, and the preference
// itself is remembered so the choice is made once. Either way a
// fine-grained token scoped to the repositories being edited limits what
// a leak is worth.

const TOKEN_KEY = "fair.wb.token";
const LOGIN_KEY = "fair.wb.login";
const PERSIST_KEY = "fair.wb.persist";

/** The stores to try, in order: the tab's own first. */
function stores() {
  const out = [];
  try {
    out.push(sessionStorage);
  } catch {
    /* blocked */
  }
  try {
    out.push(localStorage);
  } catch {
    /* blocked */
  }
  return out;
}

/** Whether the author asked to stay signed in on this device. */
export function persisting() {
  try {
    return localStorage.getItem(PERSIST_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Remember the choice, and move the token to match it.
 *
 * Turning it off has to clear the copy on disk immediately: leaving it
 * there while the UI says otherwise would be the worst of both.
 */
export function setPersisting(on) {
  try {
    if (on) localStorage.setItem(PERSIST_KEY, "1");
    else localStorage.removeItem(PERSIST_KEY);
  } catch {
    return false;
  }
  const token = storedToken();
  const login = storedLogin();
  clear();
  if (token) remember(token, login);
  return true;
}

function remember(token, login) {
  const store = persisting() ? stores()[1] ?? stores()[0] : stores()[0];
  try {
    store?.setItem(TOKEN_KEY, token);
    if (login) store?.setItem(LOGIN_KEY, login);
  } catch {
    /* private mode: the session still works, it just will not survive reload */
  }
}

function read(key) {
  for (const store of stores()) {
    try {
      const value = store.getItem(key);
      if (value) return value;
    } catch {
      /* try the next */
    }
  }
  return null;
}

export function storedToken() {
  return read(TOKEN_KEY);
}

export function storedLogin() {
  return read(LOGIN_KEY);
}

function clear() {
  for (const store of stores()) {
    try {
      store.removeItem(TOKEN_KEY);
      store.removeItem(LOGIN_KEY);
    } catch {
      /* nothing to clear */
    }
  }
}

/** Sign out everywhere, whichever store the token ended up in. */
export function signOut() {
  clear();
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
