/**
 * Shared thresholds used by both the ingestion pipeline and the query path.
 */

/**
 * Shortest passage worth indexing or returning.
 *
 * Documentation cross-reference blocks ("See Also", "References") are little
 * more than a list of link labels - PostgreSQL's are often a single word like
 * "VACUUM". They score well on lexical overlap while carrying no information,
 * so they crowd out the passage that actually answers the question. Anything
 * under this many characters cannot explain anything on its own.
 */
export const MIN_PASSAGE_CHARS = 40;
