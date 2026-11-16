// The upstream half: our Worker acts as an OAuth *client* of Google to learn who you are.
// claude.ai never sees anything from this file; it only sees the token OAuthProvider mints afterwards.
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { AuthEnv, ServerInfo, User } from "./index";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

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

	// claude.ai sends the browser here. First visit per client: show the approval page.
	app.get("/authorize", async (c) => {
		const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
		if (!oauthReqInfo.clientId) return c.text("Invalid request", 400);

		if (await isClientApproved(c.req.raw, oauthReqInfo.clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
			return startGoogleLogin(c.req.raw, c.env, oauthReqInfo);
		}

		const { token: csrfToken, setCookie } = generateCSRFProtection();
		return renderApprovalDialog(c.req.raw, {
			client: await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId),
			csrfToken,
			server: info,
			setCookie,
			state: { oauthReqInfo },
		});
	});

	// You clicked "Approve".
	app.post("/authorize", async (c) => {
		try {
			const formData = await c.req.raw.formData();
			const { clearCookie: clearCsrfCookie } = validateCSRFToken(formData, c.req.raw);

			const encodedState = formData.get("state");
			if (typeof encodedState !== "string") return c.text("Missing state", 400);
			let state: { oauthReqInfo?: AuthRequest };
			try {
				state = JSON.parse(atob(encodedState));
			} catch {
				return c.text("Invalid state", 400);
			}
			if (!state.oauthReqInfo?.clientId) return c.text("Invalid request", 400);

			const approvedCookie = await addApprovedClient(
				c.req.raw,
				state.oauthReqInfo.clientId,
				c.env.COOKIE_ENCRYPTION_KEY,
			);
			return startGoogleLogin(c.req.raw, c.env, state.oauthReqInfo, approvedCookie, clearCsrfCookie);
		} catch (error: any) {
			if (error instanceof OAuthError) return error.toResponse();
			console.error("POST /authorize", error);
			return c.text("Internal server error", 500);
		}
	});

	// Google sends the browser back here.
	app.get("/callback", async (c) => {
		let oauthReqInfo: AuthRequest;
		let clearSessionCookie: string;
		try {
			({ oauthReqInfo, clearCookie: clearSessionCookie } = await validateOAuthState(c.req.raw, c.env.OAUTH_KV));
		} catch (error: any) {
			if (error instanceof OAuthError) return error.toResponse();
			return c.text("Internal server error", 500);
		}

		const googleError = c.req.query("error");
		if (googleError) return c.text(`Google login failed: ${googleError}`, 400);
		const code = c.req.query("code");
		if (!code) return c.text("Missing code", 400);

		let redirectTo: string;
		try {
			const user = await fetchGoogleUser(c.env, code, new URL("/callback", c.req.url).href);
			if (user instanceof Response) return user;

			if (!user.verified || !isAllowed(c.env, user.email)) {
				console.warn("login rejected", { email: user.email });
				return c.text("Forbidden: this Google account is not allowed", 403);
			}

			// CLAUDE.AI #4: mint our own token for claude.ai and redirect the browser back to
			// claude.ai's callback (https://claude.ai/api/mcp/auth_callback) with an auth code.
			({ redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
				metadata: { label: user.name },
				props: { email: user.email, name: user.name } satisfies User,
				request: oauthReqInfo,
				scope: oauthReqInfo.scope,
				userId: user.id,
			}));
		} catch (error: any) {
			console.error("GET /callback", error);
			return c.text(`Login failed: ${error?.message ?? "internal error"}`, 500);
		}

		const headers = new Headers({ Location: redirectTo });
		if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);
		return new Response(null, { status: 302, headers });
	});

	return app;
}

async function startGoogleLogin(request: Request, env: AuthEnv, oauthReqInfo: AuthRequest, ...extraCookies: string[]) {
	const { stateToken } = await createOAuthState(oauthReqInfo, env.OAUTH_KV);
	const { setCookie: sessionCookie } = await bindStateToSession(stateToken);

	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
	url.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
	url.searchParams.set("scope", "email profile");
	url.searchParams.set("response_type", "code");
	url.searchParams.set("state", stateToken);

	const headers = new Headers({ Location: url.href });
	headers.append("Set-Cookie", sessionCookie);
	for (const cookie of extraCookies) if (cookie) headers.append("Set-Cookie", cookie);
	return new Response(null, { status: 302, headers });
}

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
		console.error("google token exchange failed", await tokenResp.text());
		return new Response("Failed to fetch access token", { status: 500 });
	}
	const { access_token } = (await tokenResp.json()) as { access_token?: string };
	if (!access_token) return new Response("Missing access token", { status: 400 });

	// The Google token is used once, here, and then dropped. It is never stored.
	const userResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
		headers: { Authorization: `Bearer ${access_token}` },
	});
	if (!userResp.ok) return new Response("Failed to fetch user info", { status: 500 });
	const u = (await userResp.json()) as { id: string; name: string; email: string; verified_email: boolean };
	return { id: u.id, name: u.name, email: u.email, verified: u.verified_email };
}
