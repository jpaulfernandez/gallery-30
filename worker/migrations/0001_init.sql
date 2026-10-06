-- Likes and the download log (docs/design/PRD.md, "Social records").
CREATE TABLE likes (
  book_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('page', 'photo')),
  target_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (book_id, target_type, target_id, device_id)
);
CREATE INDEX likes_book_idx ON likes (book_id);

-- target_id of a collection event (zip, share all) holds the JSON array of asset ids as text.
CREATE TABLE downloads (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('page', 'photo', 'collection')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('download', 'share', 'zip', 'page_share')),
  display_name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  page_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX downloads_book_created_idx ON downloads (book_id, created_at);
