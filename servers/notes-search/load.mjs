#!/usr/bin/env node
// Usage: node servers/notes-search/load.mjs <folder> > notes.sql
//        npx wrangler d1 execute mcp-notes-search --remote --file notes.sql
// Turns every .md file under <folder> into an upsert. The path is relative to <folder>,
// the title is the first "# " heading or the file name. Re-running updates changed notes.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const root = process.argv[2];
if (!root) {
	console.error("usage: node load.mjs <folder> > notes.sql");
	process.exit(1);
}

const sql = (s) => `'${s.replaceAll("'", "''")}'`;

for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
	if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
	const file = join(entry.parentPath, entry.name);
	const body = readFileSync(file, "utf8");
	const title = body.match(/^# (.+)$/m)?.[1].trim() ?? basename(file, ".md");
	console.log(
		`INSERT INTO notes (path, title, body) VALUES (${sql(relative(root, file))}, ${sql(title)}, ${sql(body)}) ` +
			"ON CONFLICT (path) DO UPDATE SET title = excluded.title, body = excluded.body;",
	);
}
