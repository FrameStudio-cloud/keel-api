# AGENTS.md — keel-api

The HTTP gateway every Keel storefront reads through. Hono on Node, holding the
service-role key so no browser ever holds it.

## What this file is for

This service runs on the **service-role key**, which bypasses Postgres RLS
entirely. That means **the database is not a safety net here.** Every tenant
filter is application code, and a route that forgets one is a cross-tenant leak
that nothing else will catch.

So the rule is short, and the rest of this file is the evidence for it.

---

## The rule this file will not break

**A request header is not a credential. A token is.**

`siteAuth()` reads the token from `x-keel-site-token` (or the `x-keel-token`
alias) and resolves it through `resolve_site_token`. There is **no fallback**.

### The fallback that shipped, and what it cost

An earlier version identified the shop from the request's `Origin`/`Referer`
hostname when no token was present, matching with:

```js
.ilike('website_url', `%${host}%`)
```

and the comment above it called that "tenant-safe". It was not, for two
independent reasons:

1. `Origin` and `Referer` are ordinary request headers. `curl -H "Origin:
   https://kikoi-opal.vercel.app"` sets one. A browser convention was being used
   as an authentication control.
2. The match was a **substring** test, so `Origin: https://vercel.app` also
   resolved a shop registered at `kikoi-opal.vercel.app`. One shared hosting
   platform authorised every shop hosted on it.

Verified live before removal, with **no credential of any kind**:

| Request | Result |
|---|---|
| `GET /api/settings` + forged Origin | `200`, **34 columns** including `paystack_subaccount_code`, `paystack_subaccount.bank_name`, `store_phone`, `store_address`, and the owner's email inside `notification_preferences` |
| forged Origin, all 8 read routes | `200` on every one |
| forged Origin, 5 write routes | `403` — write-token enforcement worked |
| 70 rapid tokenless reads | `70/70 200`, no `429` |
| `Origin: https://vercel.app` | `200` — the substring amplification |

The write gate was the only thing between that and a write primitive, and it
held. Do not assume the next hole will be as lucky.

### What replaces it

Nothing. A token, or a `401` with a message naming the header to send. The
migration path is issuing a token and setting `VITE_KEEL_SITE_TOKEN` in the
storefront's build — **both live storefronts already do this**
(`kikoi/src/keelClient.js`, `keel-storefront-zuri/src/api.js`).

`?site_token=` is also gone, and was a genuine leak: query strings end up in
access logs, browser history and `Referer` headers, where a token outlives the
request that carried it.

---

## Rules for adding a route

**1. Never trust a `shop_id` the caller supplied.** Not in the query, not in the
body, not in a header. Use `shopIdOf(c)`, which reads only the Hono context
variable that `siteAuth` set.

```js
export function shopIdOf(c) {
  const id = c.get('shopId')
  if (!id) throw new Error('shopId missing from context — is siteAuth() mounted?')
  return id
}
```

A client-supplied `shop_id` is structurally incapable of influencing it, which is
why a request carrying a valid product id and a *forged* `shop_id` still resolves
to the caller's own shop. Four routes bypassed this helper when the September
hardening converted the GETs and left the POSTs behind — a write-token holder
could file a callback, a stock alert or a caption request against another tenant.
**Conversion is not a single commit; check every handler in the file.**

**2. Name the columns you select. Never `select('*')`.**

Two routes used it, on tables full of secrets:

- `store_settings` → returned 34 columns including `paystack_subaccount_code` and
  the owner's email in `notification_preferences`.
- `chat_config` → returned 20 columns including `groq_api_key`,
  `whatsapp_token`, `whatsapp_verify_token` and `whatsapp_pin`. The values
  happened to be empty on the probed shop, so nothing leaked — **but the first
  shop to set a bring-your-own Groq key would have published it, with no code
  change for anyone to review.**

`select('*')` means every column added from now on is published automatically. A
new column should be a decision, not a side effect. `PUBLIC_SETTINGS` and
`PUBLIC_CHAT_CONFIG` in the route files list what is safe; adding to those lists
is a deliberate act with a reason in the commit.

Note the distinction: a shop's **own** `store_phone` and `store_address` stay in
`PUBLIC_SETTINGS`, because a token only ever resolves to its own shop and a
storefront prints its contact details on its own public site. The columns that
must never leave the server are `paystack_subaccount_code`, `paystack_subaccount`
and `notification_preferences`.

**3. A read is a write if the caller controls the input.** `/api/manifest` used
to fetch any URL from `?url=`. `new URL(url)` only checks that the string parses,
and the forced `/keel-manifest.json` suffix constrains *which path* can be
fetched but not *which host* — verified live, `?url=http://localhost:3001`
reached this same service and returned a real `404` from it, which confirms
internal reachability and turns the route into a port scanner (404 vs 502
distinguishes open from closed).

It now derives the target from the caller's **registered** `website_url`, requires
an exact host match, allows `https` only, and sets `redirect: 'error'`. **The
suffix was never the defence** — it bounded *what* could be read, not *where
from*.

**4. Never match a hostname with a substring.** `hostname.includes('vercel.app')`
is how one shared platform host authorises every shop on it. Exact equality, or
nothing.

---

## Rate limiting

The budget follows the credential's authority:

| Credential | Budget | Default |
|---|---|---|
| read token | `read` | 120/min |
| write token | `write` | 60/min |
| any token, before the DB lookup | `preAuth` | 300/min |

`preAuth` is a DoS guard on `resolve_site_token`, deliberately set **above** the
per-credential budgets, because it is keyed by token and therefore counts valid
requests too — validity is not known until after the query. An earlier draft set
it to 10/min and silently throttled every legitimate read to 10 requests a
minute.

The limiter is in-memory, so it is per-replica. `railway.json` pins
`numReplicas: 1`, so it is currently coherent; a multi-replica deploy would need
shared state.

---

## Tests

```bash
npm test          # vitest run
node scripts/mutate.mjs
```

**`src/auth.test.js`** (24) and **`src/routes/tenantIsolation.test.js`** (24) are
the security tests. They existed for neither before 30 Sep 2026, which is why all
of the above shipped.

`scripts/mutate.mjs` reintroduces each fixed bug and asserts the suite goes red —
**12 mutations, all caught.** A guard that has never been seen to fail is a
comment, not a guard. Run it after touching auth or a route's filters.

---

## Other standing rules

- **Never throw into the host app.** A storefront is a browser, not a server.
- **MCP is a separate entry point** (`src/mcp-cli.js`, stdio). It has **no
  inbound auth** — its trust model is OS process trust, and every tool takes
  `shop_id` as an ordinary argument. Never expose it, and never widen a tool's
  reach by copying a query from an HTTP route.
- **Every env var the code reads must be in `.env.example`.** `ALLOWED_ORIGINS`
  and `GROQ_API_KEY` were both undeclared, which is how the deployed CORS policy
  ended up as `*`.
- **A missing env var must fail closed.** `db.js` throws on missing credentials;
  the HTTP path surfaces a generic 500 and never returns the detail.

## Hosting

⚠️ **The repo cannot tell you.** The only hosting artefact is `railway.json`
(NIXPACKS, `npm start`, 1 replica) from the initial July commit, never modified.
There is no `render.yaml` or Dockerfile in any branch, and the string `render`
appears nowhere in the source. The service is widely understood to run at
`keel-api-37rh.onrender.com` — which matches the default `apiBase` in
`@framestudio/keel-analytics` — but that is inference from a client default, not
evidence. **Verify in the Render dashboard before documenting a host.**

## Coverage gaps, stated plainly

- CI asserts only `curl GET /`, so it would pass with invalid Supabase
  credentials.
- No test covers `db.js`, any route's happy path against a real database, or the
  MCP tools.
- `verify_jwt` and deployment state are not recorded in this repo; Render owns
  them.
