-- 002_fix_corpus_stats.sql
--
-- 001 defined corpus_stats by joining documents to chunks in one query. That
-- produces a cross product: a source with 87 sections and 310 chunks reported
-- 26970 "passages". Count each side independently instead.

DROP VIEW IF EXISTS corpus_stats;

CREATE OR REPLACE VIEW corpus_stats AS
SELECT
  s.id,
  s.name,
  s.label,
  s.color,
  s.homepage,
  s.license,
  s.version,
  (SELECT count(*)::int FROM documents d WHERE d.source = s.id) AS documents,
  (SELECT count(*)::int FROM chunks   c WHERE c.source = s.id) AS passages,
  (SELECT COALESCE(sum(length(c.text)), 0)::bigint FROM chunks c WHERE c.source = s.id) AS characters
FROM sources s;
