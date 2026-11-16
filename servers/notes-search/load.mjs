#!/usr/bin/env node
// Usage: node servers/notes-search/load.mjs [--mirror] <folder> > notes.sql
//        npx wrangler d1 execute mcp-notes-search --remote --file notes.sql
// Turns every .md file under <folder> into an upsert keyed on its path relative to <folder>.
// The title is the first "# " heading, else the file name.
//   default    add and update only; notes saved with add_note are kept
//   --mirror   make the index equal the folder: notes whose file is gone (deleted or
//              renamed) are removed, including ones saved with add_note
// Files whose statement would exceed D1's 100 KB statement limit are skipped with a warning
// (in mirror mode their existing note is kept).
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const MAX_STATEMENT_BYTES = 100_000;
const args = process.argv.slice(2);
const mirror = args[0] === "--mirror";
const root = mirror ? args[1] : args[0];
if (!root) {
	console.error("usage: node load.mjs [--mirror] <folder> > notes.sql");
	process.exit(1);
}

const sql = (s) => `'${s.replaceAll("'", "''")}'`;
const kept = [];

if (mirror) console.log("DROP TABLE IF EXISTS _load_keep; CREATE TABLE _load_keep (path TEXT PRIMARY KEY);");
for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
	if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
	const file = join(entry.parentPath, entry.name);
	const path = relative(root, file);
	const body = readFileSync(file, "utf8");
	const title = body.match(/^# (.+)$/m)?.[1].trim() ?? basename(file, ".md");
	const statement =
		`INSERT INTO notes (path, title, body) VALUES (${sql(path)}, ${sql(title)}, ${sql(body)}) ` +
		"ON CONFLICT (path) DO UPDATE SET title = excluded.title, body = excluded.body;";
	if (mirror) console.log(`INSERT OR IGNORE INTO _load_keep (path) VALUES (${sql(path)});`);
	if (Buffer.byteLength(statement) > MAX_STATEMENT_BYTES) {
		console.error(`skipped ${path}: too large for one D1 statement (split the file or use add_note)`);
		continue;
	}
	console.log(statement);
	kept.push(path);
}
if (mirror) console.log("DELETE FROM notes WHERE path NOT IN (SELECT path FROM _load_keep); DROP TABLE _load_keep;");
console.error(`${kept.length} notes${mirror ? ", mirror mode" : ""}`);
