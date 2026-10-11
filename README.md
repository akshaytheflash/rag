# DocSearch

Ask a question about Python, FastAPI or PostgreSQL and get back the passages from
the official documentation that match it — copied verbatim, ranked by embedding
similarity, and linked to the page each one came from.

**There is no language model in this system.** The only inference is a 22M-parameter
sentence encoder that maps text to a 384-number vector. Nothing is generated,
paraphrased, summarised or answered. A result is a quote and a link, or it is
nothing at all.

---

## How it works

```
INGESTION (local, on demand — never runs in production)
──────────────────────────────────────────────────────
  docs.python.org/3 ──┐
  fastapi.tiangolo.com├──▶ discover pages ──▶ extract sections ──▶ chunk
  postgresql.org/docs ─┘   (site's own         (heading-aware,       (code blocks
                            index/sitemap)     keeps <pre> whole)     never split)
                                                                       │
                                                                       ▼
                                                          embed with MiniLM-L6-v2
                                                                       │
                                                                       ▼
                                                     upsert into Postgres + pgvector

QUERY TIME (Vercel serverless function)
───────────────────────────────────────
  question ──▶ embed ──▶ SELECT … ORDER BY embedding <=> $1 DESC ──▶ verbatim passages
                (local)     cosine distance, thresholded + filtered      + source URL
```

### Retrieval, in four steps

1. **Embed the question** with the same `Xenova/all-MiniLM-L6-v2` model used at
   ingestion, producing an L2-normalised 384-dimension vector.
2. **Rank every passage** by cosine distance (`<=>`) in a single SQL statement.
   A relevance threshold converts to a distance ceiling, so weak matches are
   dropped in the database rather than filtered afterwards.
3. **Filter by manual** (Python / FastAPI / PostgreSQL / all) inside the same
   query, so filtering never reduces the candidate pool.
4. **Return the stored text as-is**, with its heading path, section title and
   canonical URL.

### About the scores

Similarity is cosine distance between two embeddings. A high score means the
passage and the question sit close together in embedding space — which reflects
vocabulary and phrasing as much as meaning. **It is a ranking signal, not a
measure of correctness.** The interface says so, and every result links to the
source so you can check it in context.

---

## Local setup

Requires Node 20+ and a Postgres 16+ database with the `vector` extension
(Neon free tier is the intended target).

```bash
npm install
npm run model:fetch          # ~23 MB of weights into ./models
cp .env.example .env.local   # then fill it in
npm run db:migrate
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | **Pooled** connection (`-pooler` host). Used for all query traffic. |
| `DATABASE_URL_UNPOOLED` | yes | **Direct** connection (no `-pooler`). Required for migrations and `CREATE EXTENSION`. |
| `EMBEDDING_MODEL` | no | Defaults to `Xenova/all-MiniLM-L6-v2`. |
| `EMBEDDING_DIM` | no | Defaults to `384`. Must match the column definition. |
| `SEARCH_TOP_K` | no | Default result count (default `8`, capped at 25). |
| `SEARCH_THRESHOLD` | no | Minimum cosine similarity (default `0.38`). |

### Choosing the relevance threshold

The default is calibrated against the indexed corpus rather than guessed.
Over ~25,000 passages, unrelated questions ("what is the capital of France",
"how do I make sourdough bread") peak around **0.28**, while the weakest
genuine match measured across the verification set was **0.61**. `0.38` sits
in that gap with margin on both sides.

Raise it if you would rather return nothing than return something loosely
related. Lower it if you are willing to trade precision for recall. Set it to
`0` to disable filtering and rank the whole corpus.

### Why two connection strings

Neon's pooled endpoint routes through PgBouncer in **transaction mode**, which
cannot service session-level state. `CREATE EXTENSION` and most migration tools
will fail against it — usually in a way that does not mention pooling
(`prepared statement "s0" already exists`, a `search_path` that silently resets,
`SQLSTATE 25006`). Migrations use the direct string; everything else uses the
pooled one.

---

## Ingestion

```bash
npm run ingest                                  # all three manuals
npm run ingest -- --source fastapi              # one manual
npm run ingest -- --source python --source postgresql
npm run ingest -- --limit 20                    # smoke test on 20 pages
npm run ingest -- --refresh                     # ignore the HTTP cache
npm run ingest -- --target-tokens 400           # larger passages
```

### Design decisions worth knowing

**Sections, not pages.** Each documentation heading becomes one row in
`documents`. A passage can therefore be cited precisely — "Bigger Applications →
Dependencies" — instead of "somewhere on a long page".

**Chunk size is capped to fit the model.** all-MiniLM-L6-v2 has a 256
word-piece position limit. Measured against the real tokenizer, a 1,280-character
chunk of documentation prose is roughly 340 word-pieces — so the tail would be
truncated before embedding and could never be matched by a query. Chunks are
therefore sized at ~800 characters. Prose is split at sentence boundaries;
**code blocks are never split**, and one larger than the target becomes its own
passage rather than being cut. `tests/chunk-model-fit.test.ts` measures this
against the actual tokenizer so the limit cannot silently regress.

**Discovery caps are never applied silently.** Each source has a `maxPages`
limit, and if discovery finds more pages than the limit allows, ingestion warns
loudly. This matters: PostgreSQL's `sql-*.html` reference pages sort last
alphabetically, so a cap set too low drops the entire SQL Commands reference
while looking like a corpus that simply never covered the topic.

**Re-running is safe and cheap.** Documents are keyed by
`(source, url, anchor)` and chunks by `(document_id, ordinal)`, so ingestion
upserts in place. Each chunk carries a content hash; only chunks whose hash
changed are re-embedded. An incremental run costs almost nothing.

**Sections removed upstream are pruned.** On a complete pass, documents that no
longer appear are deleted. This is skipped when `--limit` is set, so a smoke
test cannot wipe the index.

**Polite crawling.** Requests are serialised per host with a fixed delay, sent
under a descriptive User-Agent with a contact URL, and checked against each
host's `robots.txt`. Responses are cached in `.cache/` (gitignored) so re-runs
do not re-fetch unchanged pages. Discovery uses the site's own
`contents.html` / `sitemap.xml` where one exists rather than blind crawling.

**Writes are batched.** Neon is geographically distant, so a round trip costs a
few hundred milliseconds. Documents and chunks are written with set-based
statements in batches of 100, which turns a multi-minute ingest into a
one-minute one.

### Licences

Passages are short extracts stored for the purpose of pointing at the
original, each with a link to its source page.

| Source | Licence |
|---|---|
| Python | PSF License 2.0; code examples under Zero Clause BSD |
| FastAPI | MIT |
| PostgreSQL | PostgreSQL Licence |

The embedding weights (`./models`) are Apache-2.0; the licence text ships
alongside them.

---

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm test` | Unit tests (no database or model required) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:migrate` | Apply `db/migrations/*.sql` (needs the direct URL) |
| `npm run db:stats` | Print what is currently indexed |
| `npm run db:reset -- --yes` | Empty the index (chunks go with it via cascade) |
| `npm run ingest` | Crawl, chunk, embed and index |
| `npm run verify` | End-to-end search checks against the live index |
| `npm run model:fetch` | Download the embedding weights |

---

## Deployment

Deployed to Vercel with the Vercel CLI.

```bash
vercel --prod
```

Set `DATABASE_URL` in the Vercel project's environment variables — either in the
dashboard, or with `vercel env add DATABASE_URL production`, which prompts for
the value in your terminal so it never passes through a log or a chat.

`next.config.ts` sets `outputFileTracingIncludes` so the ONNX weights are traced
into the serverless function. Without it the function would look for the model
at runtime and fail.

Only the pooled `DATABASE_URL` is needed in production. Ingestion and migrations
are local operations and never run on Vercel.

### Free-tier limits — read this before relying on the deployment

Neither provider offers an availability guarantee, and both can change their
terms without notice.

**Vercel Hobby**
- Personal, non-commercial use only. Commercial use requires a paid plan.
- 2 GB memory / 1 vCPU per function, 250 MB uncompressed bundle.
- 4 active CPU-hours per month. This project uses roughly 0.2 s of CPU per
  query, which puts the ceiling around 70,000 queries a month — but the model
  has to be loaded on each cold start, and that load counts too.
- 100 GB bandwidth/month, 1M function invocations/month.
- No GPU. The model is small enough that CPU inference is the right choice.

**Neon Free**
- 0.5 GB storage, 100 compute-hours/month, autoscaling to 2 CU.
- **Scale to zero after 5 minutes idle.** The first query after an idle period
  pays a cold start of a few hundred milliseconds. This is the single most
  user-visible rough edge of the deployment.
- Ingesting the full corpus is roughly 30–60 MB, well inside the storage limit.

**If the demo gets real traffic**, the first thing to break will be Vercel's CPU
hour budget, then Neon's compute hours. Both are fixable by moving ingestion to
a scheduled job and caching queries, not by scaling the model.

---

## Project layout

```
db/migrations/        SQL migrations, applied in filename order
models/               embedding weights (committed, ~23 MB)
scripts/              fetch-model, migrate, stats
src/app/              Next.js App Router: page, search API, global styles
src/components/       UI, all client-side state
src/ingest/           crawler, extractor, chunker, store, CLI
src/lib/              database, embeddings, search
tests/                unit tests
```

---

## Licence

MIT for the code in this repository. The indexed documentation and the bundled
model remain under their own licences, listed above.
