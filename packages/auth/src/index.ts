// withGoogleAuth: wrap an MCP server so claude.ai can connect to it via OAuth,
// with Google as the login and an email allowlist as the gate.
import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { createGoogleHandler, isAllowed } from "./google";

export interface AuthEnv {
	OAUTH_KV: KVNamespace; // OAuth clients, grants, tokens (managed by OAuthProvider)
	MCP_RESOURCE: string; // public URL of /mcp, from wrangler.jsonc
	GOOGLE_CLIENT_ID: string; // secret
	GOOGLE_CLIENT_SECRET: string; // secret
	COOKIE_ENCRYPTION_KEY: string; // secret, random
	ALLOWED_EMAILS: string; // secret, comma-separated
}

/** Shown on the approval page. */
export interface ServerInfo {
	name: string;
	description?: string;
}

/** Stored (encrypted) in every token; read it in tools with currentUser(). */
export interface User {
	name: string;
	email: string;
}

export function currentUser(): User | undefined {
	return getMcpAuthContext()?.props as User | undefined;
}

export function withGoogleAuth(createServer: () => McpServer, info: ServerInfo) {
	const mcpHandler = createMcpHandler(createServer);

	return new OAuthProvider<AuthEnv>({
		// CLAUDE.AI #1: /mcp without a valid token answers 401 + WWW-Authenticate,
		// which tells claude.ai to start OAuth. With a token, requests reach the MCP server.
		apiRoute: "/mcp",
		apiHandler: {
			fetch(req, env, ctx) {
				// Valid token, but is its email still on the allowlist? (OAuthProvider sets ctx.props)
				const email = (ctx as ExecutionContext & { props?: User }).props?.email;
				if (!isAllowed(env, email)) return new Response("Forbidden", { status: 403 });
				return mcpHandler(req, env, ctx);
			},
		},

		// CLAUDE.AI #2: claude.ai registers itself as a client (Dynamic Client Registration).
		clientRegistrationEndpoint: "/register",

		// CLAUDE.AI #3: standard OAuth endpoints, advertised at /.well-known/oauth-authorization-server.
		// /authorize is ours (Google login, see google.ts); /token is handled by OAuthProvider (PKCE).
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/token",
		defaultHandler: createGoogleHandler(info) as any,

		// CLAUDE.AI #5: tokens are bound to this URL. It must equal the URL pasted into claude.ai.
		resourceMetadata: { resource: (env as unknown as AuthEnv).MCP_RESOURCE },
	});
}
