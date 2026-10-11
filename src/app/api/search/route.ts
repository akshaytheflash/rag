import { NextResponse } from "next/server";
import { search, resolveFilters, validateSearchInput } from "@/lib/search";

// Embedding runs on the CPU inside the function, so allow generous time on a
// cold start. Vercel's Hobby maximum is 300s; 30s is ample once warm.
export const maxDuration = 30;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/search
 *
 * Retrieval only. The response contains passages copied verbatim from the
 * official documentation, each with its canonical URL. No text is generated,
 * paraphrased or synthesised anywhere in this route.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const input = body as { query?: unknown; source?: unknown; limit?: unknown; threshold?: unknown };

  const validated = validateSearchInput(input.query);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const filters = resolveFilters({
    source: typeof input.source === "string" ? input.source : null,
    limit: typeof input.limit === "number" ? input.limit : null,
    threshold: typeof input.threshold === "number" ? input.threshold : null,
  });

  if (filters.error) {
    return NextResponse.json({ error: filters.error }, { status: 400 });
  }

  try {
    const response = await search({
      query: validated.value.query,
      source: filters.source,
      limit: filters.limit,
      threshold: filters.threshold,
    });

    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    // Log the detail server-side; return something actionable but generic.
    console.error("[search] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      {
        error:
          "The search index could not be reached. The database may be waking up or the index may still be building.",
      },
      { status: 503 },
    );
  }
}

export async function GET() {
  return NextResponse.json(
    {
      error: "Use POST with a JSON body: { \"query\": \"...\", \"source\": \"all\" }",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
