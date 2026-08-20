// Deployment configuration.
//
// The broker is the one piece of infrastructure the workbench cannot do
// without for real OAuth, because github.com's token endpoint sends no
// CORS headers. Until one is deployed, leave these empty: the workbench
// falls back to a pasted fine-grained token and is fully usable.
//
// A broker is ~30 lines. It must:
//   - accept POST {code}
//   - exchange it at https://github.com/login/oauth/access_token with the
//     client secret, which must never reach the browser
//   - return {access_token}
//   - send Access-Control-Allow-Origin for this page's origin only
//
// It never sees repository content: every read and write after sign-in
// goes browser-direct to api.github.com.

export const BROKER_URL = "";
export const CLIENT_ID = "";
