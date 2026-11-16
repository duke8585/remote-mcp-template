import { currentUser, withGoogleAuth } from "@remote-mcp/auth";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

function createServer() {
	const server = new McpServer({ name: "hello", version: "0.1.0" });

	server.registerTool(
		"whoami",
		{ description: "Return the Google identity this session authenticated as", inputSchema: z.object({}) },
		async () => {
			const user = currentUser();
			return { content: [{ type: "text", text: `${user?.name} <${user?.email}>` }] };
		},
	);

	server.registerTool(
		"add",
		{ description: "Add two numbers", inputSchema: z.object({ a: z.number(), b: z.number() }) },
		async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
	);

	return server;
}

export default withGoogleAuth(createServer, {
	name: "hello",
	description: "Smoke-test MCP server: whoami + add.",
});
