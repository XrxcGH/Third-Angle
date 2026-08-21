-- Third Angle schema.
-- STRICT tables throughout. Note that STRICT validates DATATYPES ONLY: it does
-- nothing for vocabulary drift, which is why facet uses a lookup table plus a
-- NOCASE unique index rather than free text. See DESIGN.md, risk R3.

-- ---------------------------------------------------------------- identity

CREATE TABLE IF NOT EXISTS user (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  email                TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  totp_secret          TEXT,
  totp_confirmed       INTEGER NOT NULL DEFAULT 0,
  active               INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  last_login_at        TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip         TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS session_expires ON session(expires_at);

-- Two tier login throttling. Append only, so it doubles as an audit trail.
CREATE TABLE IF NOT EXISTS login_attempt (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT,
  ip         TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  at         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS login_attempt_ip ON login_attempt(ip, at);
CREATE INDEX IF NOT EXISTS login_attempt_email ON login_attempt(email, at);

-- ---------------------------------------------------------------- taxonomy

-- Closed vocabulary. color_token is constrained to the vetted palette so an
-- admin can add and rename categories but can never introduce an unverified
-- colour. There is deliberately no free hex field anywhere in this schema.
CREATE TABLE IF NOT EXISTS facet (
  slug        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('discipline','context','status','tool')),
  color_token TEXT CHECK (color_token IN (
                'ch-mechanical','ch-electrical','ch-controls','ch-software',
                'ch-fabrication','ch-documentation','ch-business','ch-teaching')),
  blurb       TEXT,
  sort_key    TEXT NOT NULL,
  in_nav      INTEGER NOT NULL DEFAULT 0,
  nav_key     TEXT
) STRICT;
-- The line that actually closes risk R3. 'Electrical' and 'electrical' are both
-- legal TEXT; only this index stops them coexisting.
CREATE UNIQUE INDEX IF NOT EXISTS facet_label_ci ON facet(kind, label COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS facet_kind_sort ON facet(kind, sort_key);

-- ---------------------------------------------------------------- work

CREATE TABLE IF NOT EXISTS project (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  subtitle     TEXT,
  -- Tier decides how many blocks the editor offers, so the twelve slot form is
  -- never presented for a small project and the pressure to pad never appears.
  tier         TEXT NOT NULL DEFAULT 'note'
                 CHECK (tier IN ('note','build','case-study')),
  status       TEXT NOT NULL DEFAULT 'in-progress'
                 CHECK (status IN ('shipped','competed','in-progress','specification','archived')),
  context      TEXT,
  role         TEXT,
  summary_md   TEXT NOT NULL DEFAULT '',
  summary_html TEXT NOT NULL DEFAULT '',
  body_md      TEXT NOT NULL DEFAULT '',
  body_html    TEXT NOT NULL DEFAULT '',
  body_format  TEXT NOT NULL DEFAULT 'markdown' CHECK (body_format IN ('markdown')),
  started_on   TEXT,
  ended_on     TEXT,
  published    INTEGER NOT NULL DEFAULT 0,
  featured     INTEGER NOT NULL DEFAULT 0,
  -- Fractional index. Case sensitive base62: never declare this COLLATE NOCASE
  -- and never sort it with localeCompare, or the order goes silently wrong.
  sort_key     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS project_sort ON project(sort_key);
CREATE INDEX IF NOT EXISTS project_published ON project(published, sort_key);

-- The join that lets one project render many disciplines without duplicating
-- content. weight ranks results; contribution_note is the one sentence that
-- opens the project depending on which door the reviewer came through.
CREATE TABLE IF NOT EXISTS project_facet (
  project_id        INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  facet_slug        TEXT NOT NULL REFERENCES facet(slug) ON DELETE RESTRICT,
  weight            TEXT NOT NULL DEFAULT 'supporting'
                      CHECK (weight IN ('primary','significant','supporting')),
  contribution_note TEXT,
  sort_key          TEXT NOT NULL,
  PRIMARY KEY (project_id, facet_slug)
) STRICT;
CREATE INDEX IF NOT EXISTS project_facet_by_facet ON project_facet(facet_slug, weight);

-- The At a Glance strip. Reviewers scan before they read.
CREATE TABLE IF NOT EXISTS metric (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  value      TEXT NOT NULL,
  unit       TEXT,
  sort_key   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS metric_project ON metric(project_id, sort_key);

CREATE TABLE IF NOT EXISTS link (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  url        TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'other'
               CHECK (kind IN ('repo','cad','document','video','demo','other')),
  sort_key   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS link_project ON link(project_id, sort_key);

-- ---------------------------------------------------------------- evidence

-- origin is the column that closes risk R2. A downloaded McMaster caster is
-- 'third-party' and is structurally incapable of satisfying the publish gate.
CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'photo'
                  CHECK (kind IN ('photo','cad_render','drawing','schematic',
                                  'harness_photo','plot','video','other')),
  storage_key   TEXT NOT NULL UNIQUE,
  original_name TEXT,
  mime          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  -- Not nullable by policy: the upload form refuses to submit without it.
  alt           TEXT NOT NULL DEFAULT '',
  caption       TEXT,
  origin        TEXT NOT NULL DEFAULT 'original'
                  CHECK (origin IN ('original','third-party','generated')),
  captured_on   TEXT,
  release_ok    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS project_media (
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_key   TEXT NOT NULL,
  PRIMARY KEY (project_id, media_id)
) STRICT;

CREATE TABLE IF NOT EXISTS document (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  description   TEXT,
  storage_key   TEXT NOT NULL,
  original_name TEXT,
  mime          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  pages         INTEGER,
  thumb_key     TEXT,
  visibility    TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  project_id    INTEGER REFERENCES project(id) ON DELETE SET NULL,
  sort_key      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS document_page (
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  page_no     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  PRIMARY KEY (document_id, page_no)
) STRICT;

-- ---------------------------------------------------------------- freshness

-- Low ceremony build log. One field required, optionally one photo. Same table
-- the capture inbox writes to, so risks R2 and R7 share one mechanism.
CREATE TABLE IF NOT EXISTS note (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT,
  body_md    TEXT NOT NULL,
  body_html  TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES project(id) ON DELETE SET NULL,
  media_id   INTEGER REFERENCES media(id) ON DELETE SET NULL,
  published  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS note_created ON note(published, created_at DESC);

-- Single row, id = 1. Editable in under sixty seconds.
CREATE TABLE IF NOT EXISTS now_page (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  body_md    TEXT NOT NULL DEFAULT '',
  body_html  TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------- operations

-- Append only. Written from application code inside the existing write
-- transactions, not from triggers, so the actor is known.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT,
  table_name TEXT NOT NULL,
  row_id     INTEGER NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('insert','update','delete')),
  snapshot   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS audit_lookup ON audit_log(table_name, row_id, id DESC);

-- So URLs can change without breaking a bookmark a recruiter kept.
CREATE TABLE IF NOT EXISTS redirect (
  from_path  TEXT PRIMARY KEY,
  to_path    TEXT NOT NULL,
  code       INTEGER NOT NULL DEFAULT 301 CHECK (code IN (301,302,307,308)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS app_error (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  route      TEXT,
  message    TEXT NOT NULL,
  stack      TEXT,
  seen       INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS app_error_at ON app_error(seen, at DESC);

CREATE TABLE IF NOT EXISTS github_cache (
  key        TEXT PRIMARY KEY,
  etag       TEXT,
  payload    TEXT NOT NULL,
  status     INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------- search

-- One flat row per searchable thing, so projects, documents, notes and
-- discipline pages rank against each other in a single query.
CREATE TABLE IF NOT EXISTS search_index (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind     TEXT NOT NULL CHECK (kind IN ('project','document','note','discipline','page')),
  ref_id   INTEGER,
  url      TEXT NOT NULL,
  title    TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  body     TEXT NOT NULL DEFAULT '',
  tags     TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS search_index_ref ON search_index(kind, ref_id);

-- Primary matcher. unicode61, NOT porter: porter stemming plus prefix queries
-- silently returns zero rows, e.g. 'harn*' finds nothing in an index containing
-- 'harnesses'. tests/search.test.mjs fails if someone changes this.
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title, subtitle, body, tags,
  content='search_index',
  content_rowid='id',
  tokenize='unicode61'
);

-- Typo and substring fallback, queried only when the primary returns zero rows.
-- Verified present in the SQLite bundled with Node 24.
CREATE VIRTUAL TABLE IF NOT EXISTS search_trgm USING fts5(
  title, subtitle, tags,
  content='search_index',
  content_rowid='id',
  tokenize='trigram'
);

-- Term vocabulary, used by the "did you mean" pass. A trigram MATCH cannot
-- recover a transposition or a dropped letter, because FTS5 requires every
-- trigram of the query term to be present; only edit distance can.
CREATE VIRTUAL TABLE IF NOT EXISTS search_vocab USING fts5vocab(search_fts, 'row');

CREATE TRIGGER IF NOT EXISTS search_index_ai AFTER INSERT ON search_index BEGIN
  INSERT INTO search_fts(rowid, title, subtitle, body, tags)
    VALUES (new.id, new.title, new.subtitle, new.body, new.tags);
  INSERT INTO search_trgm(rowid, title, subtitle, tags)
    VALUES (new.id, new.title, new.subtitle, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS search_index_ad AFTER DELETE ON search_index BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, subtitle, body, tags)
    VALUES ('delete', old.id, old.title, old.subtitle, old.body, old.tags);
  INSERT INTO search_trgm(search_trgm, rowid, title, subtitle, tags)
    VALUES ('delete', old.id, old.title, old.subtitle, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS search_index_au AFTER UPDATE ON search_index BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, subtitle, body, tags)
    VALUES ('delete', old.id, old.title, old.subtitle, old.body, old.tags);
  INSERT INTO search_trgm(search_trgm, rowid, title, subtitle, tags)
    VALUES ('delete', old.id, old.title, old.subtitle, old.tags);
  INSERT INTO search_fts(rowid, title, subtitle, body, tags)
    VALUES (new.id, new.title, new.subtitle, new.body, new.tags);
  INSERT INTO search_trgm(rowid, title, subtitle, tags)
    VALUES (new.id, new.title, new.subtitle, new.tags);
END;
