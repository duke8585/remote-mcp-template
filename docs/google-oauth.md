# Google OAuth setup

The Worker uses Google only to learn who is logging in.
You need one OAuth client in a Google Cloud project, shared by all your servers, with one redirect URI per server.
It takes about ten minutes and costs nothing.

## 1. Project

Open [console.cloud.google.com](https://console.cloud.google.com/) and create a project (or reuse one).
No APIs need enabling. The `email` and `profile` scopes work out of the box.

## 2. Consent screen (Google Auth Platform)

In the menu, go to **Google Auth Platform** (older consoles call it **APIs & Services -> OAuth consent screen**) and click **Get started**.

| Field | Value |
|---|---|
| App name | anything, e.g. `My MCP servers`. Shown on Google's login screen |
| User support email | your address |
| Audience | **External** (Internal only exists for Workspace orgs and limits logins to that org) |
| Contact email | your address |

Under **Audience**, leave the publishing status on **Testing** and add every Google account that should be able to log in as a **test user**.

Testing mode is a feature here, not a stopgap.
Google itself refuses anyone who is not a test user, so it acts as a second gate in front of the Worker's `ALLOWED_EMAILS`.
The usual Testing caveat (refresh tokens expire after 7 days) does not matter, because the Worker uses the Google token once at login and then drops it.

## 3. OAuth client

Under **Clients**, click **Create client**.

| Field | Value |
|---|---|
| Application type | **Web application** |
| Name | anything |
| Authorized JavaScript origins | leave empty |
| Authorized redirect URIs | `https://mcp-<server>.<subdomain>.workers.dev/callback`, one per server |

`scripts/provision.sh` prints the exact URI for each server.
Add a new line here every time you add a server; the client and its secret stay the same.

Click **Create**, then **Download JSON** right away.
Newer consoles show the client secret only once, at creation.
Keep the file out of the repo (`client_secret*.json` is gitignored) and delete it once the secrets are set.

## 4. Hand it to the Worker

```text
scripts/set-secrets.sh hello ~/Downloads/client_secret_XXXX.json you@gmail.com
```

The script warns if the JSON does not list the server's redirect URI, deploys the Worker, and pipes `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS` and a random `COOKIE_ENCRYPTION_KEY` into `wrangler secret put` over stdin, so no value lands in your shell history.

If you add redirect URIs later, the downloaded JSON goes stale, so the warning can fire even though the console is correct.
In that case, check the console and ignore the warning.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Google shows `Error 400: redirect_uri_mismatch` | The `/callback` URI for this server is missing or mistyped in the client. Changes can take a few minutes to apply |
| Google shows `Error 403: access_denied` | The account is not a test user (step 2) |
| Worker answers `Forbidden: this Google account is not allowed` | Google login worked, but the email is not in `ALLOWED_EMAILS`. `npx wrangler tail` shows `login rejected` with the email |
| claude.ai says it cannot connect | Run `scripts/smoke.sh <server>`. `/mcp` must answer 401, and the URL in claude.ai must equal `MCP_RESOURCE` exactly |
