-- 003_docs_tsvector.sql
--
-- Wraps to_tsvector so it can back a GENERATED column.
--
-- to_tsvector(regconfig, text) is only STABLE, so Postgres refuses to use it
-- in a generated column: the text-search configuration is a runtime lookup.
--
-- Fixing the configuration inside the wrapper makes the call immutable for our
-- purposes. The dictionary is chosen when the database is created and does not
-- vary by session or role, so the value is the same on every call. The
-- parameter is deliberately absent so that no caller can smuggle in a
-- configuration that is not pinned.
--
-- This is a separate file from the one that adds the column, and that is not
-- cosmetic: Postgres will not accept a generated column that calls a function
-- created earlier in the *same* transaction, because the function is not yet
-- committed. Running this first lets it commit before 004 references it.

CREATE OR REPLACE FUNCTION docs_tsvector(text) RETURNS tsvector
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT to_tsvector('english', $1)
$$;