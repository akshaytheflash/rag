import { streamWithFallback } from "@/lib/answer/chain";
import type { PromptPassage } from "@/lib/answer/prompt";
import { encodeFrame } from "@/lib/answer/sse";

/**
 * Answer generation runs on a remote provider, so there is no cold start to
 * absorb on our side. 30s matches /api/search and leaves room for the fallback
 * chain to try its second model before the platform gives up.
 */
export const maxDuration = 30;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bounds on what a caller may ask for.
 *
 * The endpoint forwards text to a paid third-party model, so it must not be
 * usable as an open proxy. Passages are clipped and the count is capped here
 * rather than trusting the client to have retrieved them - the numbers are
 * about cost and about how much context actually fits the model's attention.
 */
const MAX_PASSAGES = 6;
const MAX_PASSAGE_CHARS = 1200;
const MAX_QUESTION_CHARS = 400;

/**
 * Ceiling on the whole request body, enforced from the declared length before
 * anything is parsed. Six clipped passages plus a question land around 8 KB;
 * this is generous, and exists so a large body is rejected on the header alone
 * rather than being read into memory first.
 */
const MAX_BODY_BYTES = 64 * 1024;

interface IncomingPassage {
  index?: unknown;
  text?: unknown;
  sectionTitle?: unknown;
  sourceLabel?: unknown;
}

function readPassages(raw: unknown): PromptPassage[] {
  if (!Array.isArray(raw)) return [];

  const passages: PromptPassage[] = [];

  for (const item of raw.slice(0, MAX_PASSAGES)) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as IncomingPassage;

    if (typeof p.text !== "string" || !p.text.trim()) continue;

    passages.push({
      // Re-derived from array position rather than trusted: a caller-supplied
      // index that disagrees with the order would silently mislabel every
      // citation below.
      index: passages.length + 1,
      text: p.text.slice(0, MAX_PASSAGE_CHARS),
      sectionTitle: typeof p.sectionTitle === "string" ? p.sectionTitle.slice(0, 200) : "Passage",
      sourceLabel: typeof p.sourceLabel === "string" ? p.sourceLabel.slice(0, 80) : "",
    });
  }

  return passages;
}

/**
 * POST /api/answer
 *
 * Streams an answer as server-sent events. One `token` frame per fragment, then
 * a final `done` frame naming the model that produced it.
 *
 * The passages arrive in the request rather than being retrieved again here.
 * The client has already run the search - it is what put those passages on
 * screen - so re-running retrieval inside this route would double the latency
 * of the whole feature for an identical result.
 */
export async function POST(request: Request) {
  // Checked before parsing. Content-Length is a client-supplied claim, so it is
  // treated as a fast reject, not as the limit itself - the real bound is the
  // per-field clipping in readPassages below, which a lying header cannot
  // inflate.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const input = body as { question?: unknown; passages?: unknown };

  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) {
    return Response.json({ error: "A question is required." }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return Response.json({ error: `Keep the question under ${MAX_QUESTION_CHARS} characters.` }, { status: 400 });
  }

  const passages = readPassages(input.passages);
  if (passages.length === 0) {
    return Response.json(
      { error: "No passages were supplied. Search first, then ask about the results." },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();

  // Anything the request did not send a signal for: the user closed the tab, or
  // started a new search. Passed to the provider so the upstream request is
  // torn down rather than left running and billed.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Parameters<typeof encodeFrame>[0]) => {
        controller.enqueue(encoder.encode(encodeFrame(event)));
      };

      try {
        const outcome = await streamWithFallback({ question, passages }, (text) => send({ type: "token", text }), abort.signal);

        send({
          type: "done",
          generatorId: outcome.generatorId,
          generatorLabel: outcome.generatorLabel,
          fellBack: outcome.fellBack,
        });
      } catch (err) {
        if (!abort.signal.aborted) {
          console.error("[answer] failed:", err instanceof Error ? err.message : String(err));
          send({ type: "error", message: "The answer service stopped responding." });
        }
      } finally {
        controller.close();
      }
    },

    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // Stops any intermediary from collecting the stream and sending it as
      // one lump, which would defeat the point of generating it incrementally.
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET() {
  return Response.json(
    { error: 'Use POST with a JSON body: { "question": "...", "passages": [...] }' },
    { status: 405, headers: { Allow: "POST" } },
  );
}