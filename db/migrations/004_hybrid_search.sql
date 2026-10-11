-- 004_hybrid_search.sql
--
-- Adds a lexical retriever alongside the existing vector one.
--
-- Semantic search is weak at exactly the queries documentation search is made
-- of: an API name, a function signature, an error code. all-MiniLM-L6-v2 maps
-- `httpx.AsyncClient` and prose about HTTP clients to nearby points, because
-- the identifier itself carries little distributional signal. BM25 matches on
-- the literal term, so it recovers those.
--
-- lakebase_text provides a real BM25 implementation (`to_bm25query`, negative
-- scores, corpus-aware ranking) plus a `lakebase_bm25` access method that
-- pushes top-K into the index. Both need Postgres 16+; this database is 18.6.
--
-- Applied with the DIRECT connection, like every other migration here.

CREATE EXTENSION IF NOT EXISTS lakebase_text;

-- ---------------------------------------------------------------------------
-- A stored tsvector for each passage.
--
-- It is a plain column maintained by a trigger, not a GENERATED column, and
-- that is a forced choice rather than a preference. Postgres requires every
-- function in a generation expression to be IMMUTABLE, and the two this needs
-- are not:
--
--   - to_tsvector(regconfig, text) is STABLE because the configuration is a
--     runtime lookup (wrapped above in 003 to fix that).
--   - array_to_string() is STABLE too - it is the natural way to flatten the
--     heading path, and it is disqualifying on its own.
--
-- A trigger sidesteps the check entirely and keeps the heading path in the
-- index, which is worth having: a passage is often retrieved by the heading it
-- sits under ("Dependencies", "Window Functions"), and those words appear
-- nowhere in the prose itself.
--
-- The trigger is the only place text_tsv is written. Nothing else sets it.
-- ---------------------------------------------------------------------------
ALTER TABLE chunks DROP COLUMN IF EXISTS text_tsv;
ALTER TABLE chunks ADD COLUMN text_tsv tsvector;

CREATE OR REPLACE FUNCTION chunks_set_text_tsv() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.text_tsv :=
    setweight(docs_tsvector(coalesce(NEW.text, '')), 'A') ||
    setweight(docs_tsvector(coalesce(array_to_string(NEW.heading_path, ' '), '')), 'B');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chunks_text_tsv_trg ON chunks;
CREATE TRIGGER chunks_text_tsv_trg
  BEFORE INSERT OR UPDATE OF text, heading_path ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunks_set_text_tsv();

-- Backfill rows that predate the trigger. Re-ingesting would also do this, but
-- that is two hours of CPU for something one statement can do.
CREATE OR REPLACE FUNCTION chunks_set_text_tsv_row(text, text[]) RETURNS tsvector
LANGUAGE sql STABLE AS $$
  SELECT setweight(docs_tsvector(coalesce($1, '')), 'A') ||
         setweight(docs_tsvector(coalesce(array_to_string($2, ' '), '')), 'B')
$$;

UPDATE chunks SET text_tsv = chunks_set_text_tsv_row(text, heading_path)
  WHERE text_tsv IS NULL;

-- The BM25 index. Built after the column exists, so its statistics describe the
-- rows that are actually here.
--
-- k1 = 1.2 and b = 0.75 are BM25's defaults, kept deliberately: they are the
-- values the algorithm was tuned on, and nothing here has measured a better
-- pair for documentation passages. They are written out so the choice is
-- visible rather than inherited silently.
CREATE INDEX IF NOT EXISTS chunks_text_bm25
  ON chunks USING lakebase_bm25 (text_tsv)
  WITH (k1 = 1.2, b = 0.75);

-- Refresh the statistics BM25 scores against. The corpus was bulk-loaded, so
-- the index would otherwise rank against whatever it saw while building.
--
-- ANALYZE rather than VACUUM ANALYZE: this file runs inside a transaction, and
-- VACUUM cannot run in one. Only the statistics matter for scoring, and ANALYZE
-- is what collects them.
ANALYZE chunks;