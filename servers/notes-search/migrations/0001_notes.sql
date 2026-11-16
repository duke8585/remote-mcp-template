CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);

-- Full-text index over title and body, kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, body);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
	INSERT INTO notes_fts (rowid, path, title, body) VALUES (new.rowid, new.path, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
	DELETE FROM notes_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
	DELETE FROM notes_fts WHERE rowid = old.rowid;
	INSERT INTO notes_fts (rowid, path, title, body) VALUES (new.rowid, new.path, new.title, new.body);
END;
