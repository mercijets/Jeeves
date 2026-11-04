-- Jeeves D1 schema
-- One row per source file in the Jeeves Library shared drive.
CREATE TABLE IF NOT EXISTS documents (
  drive_id        TEXT PRIMARY KEY,          -- Google Drive file id
  name            TEXT NOT NULL,             -- file name in Drive
  path            TEXT NOT NULL,             -- folder path inside the library
  md5             TEXT,                      -- Drive md5Checksum, used to detect changes
  family          TEXT NOT NULL,             -- e.g. 'AFM 75FMA', 'OM 75OM', 'Company GOM', 'Training'
  doc_kind        TEXT NOT NULL,             -- section | tc | supplement | front_matter | manual | training | company | reference
  title           TEXT NOT NULL,             -- human title used in citations
  authority       INTEGER NOT NULL,          -- 1 FAA-approved, 2 manufacturer, 3 company, 4 training/study
  authority_label TEXT NOT NULL,
  revision        TEXT,                      -- e.g. 'Rev 02', 'TC-R02-33', 'S08 Rev 03'
  rev_date        TEXT,                      -- ISO date if known
  effectivity     TEXT NOT NULL,             -- human text, e.g. 'SN 0173-0500; SN 0001-0172 w/ SB750-71-10'
  serial_groups   TEXT NOT NULL,             -- JSON array of group codes: ["LOW","HIGH"] etc.
  access          TEXT NOT NULL DEFAULT 'all', -- all | pilots | maintenance
  page_count      INTEGER,
  active          INTEGER NOT NULL DEFAULT 1,  -- 0 when archived/removed
  indexed_at      TEXT
);

-- One row per indexed page (the citation unit).
CREATE TABLE IF NOT EXISTS pages (
  id          TEXT PRIMARY KEY,              -- drive_id:page_index
  drive_id    TEXT NOT NULL REFERENCES documents(drive_id),
  page_index  INTEGER NOT NULL,              -- 0-based index in the PDF
  page_label  TEXT,                          -- printed page number, e.g. '2-210-1'
  config_code TEXT,                          -- AFM configuration code on the page (AA, AB, ...)
  is_tc_inline INTEGER NOT NULL DEFAULT 0,   -- TC page found inside a section file (skipped for answers)
  image_key   TEXT,                          -- R2 key of the rendered page image
  has_figure  INTEGER NOT NULL DEFAULT 0     -- page is mostly a chart/figure
);
CREATE INDEX IF NOT EXISTS pages_label ON pages(page_label);

-- Retrieval chunks (usually one per page; long pages are split).
CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,              -- drive_id:page_index:n
  drive_id    TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  heading     TEXT,
  text        TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, heading, content='chunks', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.rowid, new.text, new.heading);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading) VALUES ('delete', old.rowid, old.text, old.heading);
END;

-- Which AFM page each live Temporary Change replaces.
CREATE TABLE IF NOT EXISTS tc_overrides (
  tc_number   TEXT NOT NULL,                 -- e.g. 'TC-R02-33'
  afm_page    TEXT NOT NULL,                 -- e.g. '2-210-1'
  drive_id    TEXT NOT NULL,                 -- the TC file
  effectivity TEXT NOT NULL,
  PRIMARY KEY (tc_number, afm_page)
);

-- Every question asked, for the test set and training-gap review.
CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  asked_at    TEXT NOT NULL,
  channel     TEXT,                          -- slack | web | mcp
  user_ref    TEXT,
  serial      TEXT,                          -- serial number typed in the question, if any
  question    TEXT NOT NULL,
  answer      TEXT,
  cited       TEXT,                          -- JSON array of page ids
  feedback    INTEGER                        -- 1 up, -1 down
);

-- Chief Pilot notes: short verified corrections/clarifications (e.g. a study aid's unit error).
-- Retrieved alongside documents and cited; they never override FAA-approved values.
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  text        TEXT NOT NULL,
  keywords    TEXT,                          -- extra search words
  applies_to  TEXT NOT NULL DEFAULT 'All serial numbers',
  author      TEXT NOT NULL DEFAULT 'Chief Pilot',
  created_at  TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, text, keywords, content='notes', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, text, keywords) VALUES (new.id, new.title, new.text, new.keywords);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, text, keywords) VALUES ('delete', old.id, old.title, old.text, old.keywords);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, text, keywords) VALUES ('delete', old.id, old.title, old.text, old.keywords);
  INSERT INTO notes_fts(rowid, title, text, keywords) VALUES (new.id, new.title, new.text, new.keywords);
END;
