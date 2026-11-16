// The upstream half: our Worker acts as an OAuth *client* of Google to learn who you are.
// claude.ai never sees anything from this file; it only sees the token OAuthProvider mints afterwards.
//
// All request state (consent handle, upstream state, approval cookie) is kept by OAuthProvider:
// every AuthRequest used here comes from parseAuthRequest, approveConsent or finishUpstream,
// never from a form field or query parameter we parsed ourselves.
import {
	type AuthRequest,
	AuthorizationError,
	type AuthorizationErrorCode,
	authorizationErrorRedirect,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { AuthEnv, ServerInfo, User } from "./index";

type Bindings = AuthEnv & { OAUTH_PROVIDER: OAuthHelpers };

// Google only proves "has a Google account". Fail closed: empty allowlist lets nobody in.
// Checked at login (/callback) and on every /mcp request (index.ts), so removing an
// email from ALLOWED_EMAILS also locks out tokens that were already issued.
export function isAllowed(env: AuthEnv, email: string | undefined): boolean {
	if (!email) return false;
	return (env.ALLOWED_EMAILS ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean)
		.includes(email.toLowerCase());
}

export function createGoogleHandler(info: ServerInfo) {
	const app = new Hono<{ Bindings: Bindings }>();

	// claude.ai sends the browser here. Show the approval page unless this browser already
	// approved this exact client, redirect URI and scope set (signed cookie, 30 days).
	app.get("/authorize", async (c) => {
		let request: AuthRequest;
		try {
			request = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
		} catch (error) {
			return rejectAuthRequest(error);
		}
		const provider = c.env.OAUTH_PROVIDER;
		if (await provider.isConsentRemembered(c.req.raw, request, { secret: c.env.CONSENT_SECRET })) {
			return startGoogleLogin(c.req.raw, c.env, request, new Headers());
		}
		const consent = await provider.describeConsent(request);
		const { handle, headers } = await provider.beginConsent(request);
		return approvalPage(info, consent, handle, headers);
	});

	// You clicked Approve or Cancel. The handle is single use and bound to this browser by a cookie.
	app.post("/authorize", async (c) => {
		const form = await c.req.raw.formData().catch(() => undefined);
		const handle = form?.get("handle");
		if (typeof handle !== "string" || !handle) return errorPage(400, "This approval form is incomplete. Start again from Claude.");
		const provider = c.env.OAUTH_PROVIDER;
		try {
			if (form?.get("action") === "cancel") {
				const denied = await provider.denyConsent(c.req.raw, handle);
				return redirect(denied.headers);
			}
			const approved = await provider.approveConsent(c.req.raw, handle, {
				remember: { secret: c.env.CONSENT_SECRET },
			});
			return startGoogleLogin(c.req.raw, c.env, approved.request, approved.headers);
		} catch (error) {
			if (error instanceof AuthorizationError) return errorPage(400, "This approval expired or was already used. Start again from Claude.");
			throw error;
		}
	});

	// Google sends the browser back here.
	app.get("/callback", async (c) => {
		let request: AuthRequest;
		let headers: Headers;
		try {
			({ request, headers } = await c.env.OAUTH_PROVIDER.finishUpstream(c.req.raw));
		} catch (error) {
			if (error instanceof AuthorizationError) return errorPage(400, "This login expired or was already used. Start again from Claude.");
			throw error;
		}
		// From here on the client's request is known, so every failure goes back to claude.ai
		// as an OAuth error instead of leaving the connector dialog waiting.
		const backToClient = (code: AuthorizationErrorCode, description: string) =>
			redirect(headers, authorizationErrorRedirect(request, code, description));

		const googleError = c.req.query("error");
		if (googleError) return backToClient("access_denied", "Google login was cancelled or failed");
		const code = c.req.query("code");
		if (!code) return backToClient("invalid_request", "Google returned no authorization code");

		const user = await fetchGoogleUser(c.env, code, new URL("/callback", c.req.url).href);
		if (!user) return backToClient("server_error", "Could not read the Google account");
		if (!user.verified || !isAllowed(c.env, user.email)) {
			console.warn("login rejected", { email: user.email });
			return backToClient("access_denied", "This Google account is not allowed on this server");
		}

		// CLAUDE.AI #4: mint our own token for claude.ai and redirect the browser back to
		// claude.ai's callback (https://claude.ai/api/mcp/auth_callback) with an auth code.
		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			metadata: { label: user.name },
			props: { email: user.email, name: user.name } satisfies User,
			request,
			scope: request.scope,
			userId: user.id,
		});
		return redirect(headers, redirectTo);
	});

	return app;
}

async function startGoogleLogin(request: Request, env: Bindings, authRequest: AuthRequest, headers: Headers) {
	const upstream = await env.OAUTH_PROVIDER.beginUpstream(authRequest, { headers });
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
	url.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
	url.searchParams.set("scope", "email profile");
	url.searchParams.set("response_type", "code");
	url.searchParams.set("state", upstream.state);
	return redirect(upstream.headers, url.href);
}

/** Returns the Google user, or undefined if Google refused the code. Logs the reason. */
async function fetchGoogleUser(env: AuthEnv, code: string, redirectUri: string) {
	const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: redirectUri,
		}),
	});
	if (!tokenResp.ok) {
		console.error("google token exchange failed", tokenResp.status, await tokenResp.text());
		return undefined;
	}
	const { access_token } = (await tokenResp.json()) as { access_token?: string };
	if (!access_token) return undefined;

	// The Google token is used once, here, and then dropped. It is never stored.
	const userResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
		headers: { Authorization: `Bearer ${access_token}` },
	});
	if (!userResp.ok) {
		console.error("google userinfo failed", userResp.status);
		return undefined;
	}
	const u = (await userResp.json()) as { id: string; name: string; email: string; verified_email: boolean };
	return { id: u.id, name: u.name, email: u.email, verified: u.verified_email };
}

// An invalid /authorize request. Redirect the error to the client only when the library
// validated the redirect URI; otherwise show it here.
function rejectAuthRequest(error: unknown): Response {
	if (error instanceof AuthorizationError) {
		if (error.redirectTo) return redirect(new Headers(), error.redirectTo);
		return errorPage(400, `Invalid connection request: ${error.description}`);
	}
	console.warn("invalid authorization request", error);
	return errorPage(400, "Invalid connection request. Start again from Claude.");
}

function redirect(headers: Headers, location?: string): Response {
	if (location) headers.set("Location", location);
	headers.set("Cache-Control", "no-store");
	return new Response(null, { status: 302, headers });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function htmlPage(status: number, title: string, body: string, headers = new Headers()): Response {
	headers.set("Content-Type", "text/html; charset=utf-8");
	headers.set("Cache-Control", "no-store");
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f5f4;color:#1c1917}
main{background:#fff;padding:1.5rem;border-radius:12px;box-shadow:0 1px 4px #0002;width:min(26rem,90vw)}
h1{font-size:1.2rem;margin:0 0 .5rem}.muted{color:#57534e;font-size:.9rem}form{display:flex;gap:.5rem;margin-top:1rem}
button{font:inherit;padding:.55rem 1rem;border-radius:8px;border:0;background:#1c1917;color:#fff;cursor:pointer}
button.secondary{background:#e7e5e4;color:#1c1917}</style></head><body><main>${body}</main></body></html>`,
		{ status, headers },
	);
}

function errorPage(status: number, message: string): Response {
	return htmlPage(status, "Error", `<h1>Something went wrong</h1><p role="alert">${escapeHtml(message)}</p>`);
}

// Every string in `consent` may come from the client (dynamic registration), so all of it is escaped.
function approvalPage(info: ServerInfo, consent: ConsentDescription, handle: string, headers: Headers): Response {
	const loopback = consent.redirectIsLoopback
		? `<p class="muted">It returns to a program on this computer (${escapeHtml(consent.redirectHost)}). Approve only if you just started this.</p>`
		: `<p class="muted">After Google login you will be sent back to <strong>${escapeHtml(consent.redirectHost)}</strong>.</p>`;
	const description = info.description ? `<p class="muted">${escapeHtml(info.description)}</p>` : "";
	return htmlPage(
		200,
		`Connect to ${info.name}`,
		`<h1>Connect to ${escapeHtml(info.name)}</h1>${description}
<p><strong>${escapeHtml(consent.clientName)}</strong> wants access to this MCP server.</p>${loopback}
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="cancel" class="secondary">Cancel</button></form>`,
		headers,
	);
}
