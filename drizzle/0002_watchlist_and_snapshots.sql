DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE watch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_item_id INTEGER NOT NULL,
  store TEXT NOT NULL,
  status TEXT NOT NULL,
  checked_at INTEGER,
  pending_since INTEGER,
  error TEXT,
  products TEXT NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE UNIQUE INDEX snapshots_item_store ON snapshots (watch_item_id, store);
