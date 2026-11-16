-- `id` is an explicit INTEGER PRIMARY KEY so it never changes (an implicit rowid may be
-- renumbered by VACUUM or an export/import); the FTS rows are keyed on it.
CREATE TABLE IF NOT EXISTS notes (
	id INTEGER PRIMARY KEY,
	path TEXT NOT NULL UNIQUE,
	title TEXT NOT NULL,
	body TEXT NOT NULL
);

-- Full-text index over title and body, kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, body);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
	INSERT INTO notes_fts (rowid, path, title, body) VALUES (new.id, new.path, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
	DELETE FROM notes_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
	DELETE FROM notes_fts WHERE rowid = old.id;
	INSERT INTO notes_fts (rowid, path, title, body) VALUES (new.id, new.path, new.title, new.body);
END;
