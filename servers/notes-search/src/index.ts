import { env } from "cloudflare:workers";
import { withGoogleAuth } from "@remote-mcp/auth";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const db = () => (env as unknown as { DB: D1Database }).DB;
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

// Each word becomes a quoted FTS5 term, so user input is matched literally
// instead of being parsed as FTS5 syntax (AND, NEAR, *, column filters).
const ftsQuery = (query: string) =>
	query
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => `"${word.replaceAll('"', '""')}"`)
		.join(" AND ");

function createServer() {
	const server = new McpServer({ name: "notes-search", version: "0.1.0" });

	server.registerTool(
		"search",
		{
			description: "Full-text search over all notes. Returns paths, titles and excerpts; read a hit with read_note.",
			inputSchema: z.object({
				query: z.string().trim().min(1).max(500).describe("Words that must all appear"),
				limit: z.number().int().min(1).max(50).default(10),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ query, limit }) => {
			const { results } = await db()
				.prepare(
					"SELECT path, title, snippet(notes_fts, 2, '[', ']', '...', 32) AS excerpt FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?",
				)
				.bind(ftsQuery(query), limit)
				.all();
			return text(results.length ? JSON.stringify(results) : "No matches.");
		},
	);

	server.registerTool(
		"read_note",
		{
			description: "Read one note in full by its path",
			inputSchema: z.object({ path: z.string().min(1).max(500) }),
			annotations: { readOnlyHint: true },
		},
		async ({ path }) => {
			const row = await db().prepare("SELECT body FROM notes WHERE path = ?").bind(path).first<{ body: string }>();
			return row ? text(row.body) : { ...text(`No note at "${path}". Use search to find paths.`), isError: true };
		},
	);

	server.registerTool(
		"add_note",
		{
			description: "Create or overwrite a note",
			inputSchema: z.object({
				path: z.string().min(1).max(500).describe('Unique key, e.g. "ideas/workers.md"'),
				title: z.string().min(1).max(200),
				body: z.string().min(1).max(100_000).describe("Markdown"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async ({ path, title, body }) => {
			await db()
				.prepare(
					"INSERT INTO notes (path, title, body) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET title = excluded.title, body = excluded.body",
				)
				.bind(path, title, body)
				.run();
			return text(`Saved ${path}.`);
		},
	);

	return server;
}

export default withGoogleAuth(createServer, {
	name: "notes-search",
	description: "Search, read and add notes in a D1 full-text index.",
});
