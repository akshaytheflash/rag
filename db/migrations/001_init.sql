-- 001_init.sql
-- Retrieval index for the developer documentation assistant.
--
-- Apply with a DIRECT (non-pooled) connection: the pooled connection goes
-- through PgBouncer in transaction mode, which cannot run CREATE EXTENSION.
--
--   npm run db:migrate

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- The three documentation sets we index.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  label      text NOT NULL,
  homepage   text NOT NULL,
  color      text NOT NULL,
  license    text NOT NULL,
  version    text
);

INSERT INTO sources (id, name, label, homepage, color, license, version) VALUES
  ('python',     'Python',     'Python',     'https://docs.python.org/3/',                  '#3b82c4', 'PSF License 2.0; code examples under Zero Clause BSD', NULL),
  ('fastapi',    'FastAPI',    'FastAPI',    'https://fastapi.tiangolo.com/',               '#05948b', 'MIT',                                        NULL),
  ('postgresql', 'PostgreSQL', 'PostgreSQL', 'https://www.postgresql.org/docs/current/',    '#2e5c8a', 'PostgreSQL License',                         NULL)
ON CONFLICT (id) DO UPDATE SET
  name     = EXCLUDED.name,
  label    = EXCLUDED.label,
  homepage = EXCLUDED.homepage,
  color    = EXCLUDED.color,
  license  = EXCLUDED.license;

-- ---------------------------------------------------------------------------
-- One row per documentation section. A section is the unit that gets chunked,
-- so a page with many headings produces many rows.
--
-- (source, url, anchor) is the stable natural key: it survives re-ingestion
-- and lets us upsert instead of duplicating.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id             bigserial PRIMARY KEY,
  source         text        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url            text        NOT NULL,
  anchor         text        NOT NULL DEFAULT '',
  title          text        NOT NULL,
  heading_path   text[]      NOT NULL DEFAULT '{}',
  section_title  text,
  version        text,
  content_hash   text        NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, url, anchor)
);

CREATE INDEX IF NOT EXISTS documents_source_idx ON documents (source);

-- ---------------------------------------------------------------------------
-- Retrieved passages. `text` is always verbatim documentation prose or code
-- copied from the source page; it is never rewritten or summarised.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
  id             bigserial PRIMARY KEY,
  document_id    bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source         text   NOT NULL REFERENCES sources(id)  ON DELETE CASCADE,
  ordinal        int    NOT NULL,
  heading_path   text[] NOT NULL DEFAULT '{}',
  text           text   NOT NULL,
  char_count     int    NOT NULL,
  token_estimate int    NOT NULL,
  content_hash   text   NOT NULL,
  embedding      vector(384) NOT NULL,
  UNIQUE (document_id, ordinal)
);

-- Keep the denormalised source in sync and support the source filter.
CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks (source);

-- HNSW gives approximate search headroom if the corpus grows. At the current
-- corpus size Postgres correctly prefers the exact sequential scan, which is
-- what we want: exact nearest neighbours, no recall loss.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Small helper for the "what is actually indexed" panel on the landing page.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW corpus_stats AS
SELECT
  s.id,
  s.name,
  s.label,
  s.color,
  s.homepage,
  s.license,
  s.version,
  count(DISTINCT d.id)::int AS documents,
  count(c.id)::int          AS passages
FROM sources s
LEFT JOIN documents d ON d.source = s.id
LEFT JOIN chunks   c ON c.source = s.id
GROUP BY s.id, s.name, s.label, s.color, s.homepage, s.license, s.version;
