import { Suspense } from "react";
import { DocSearchApp } from "@/components/DocSearchApp";
import { getCorpusStats, type CorpusStat } from "@/lib/search";

// The landing page reads live counts, so it must not be cached at build time.
export const dynamic = "force-dynamic";

/**
 * If the database is unreachable the page still renders: the shell, the search
 * box and the filters all work, and the contents panel simply reports that the
 * index is unavailable. A cold-starting database should not produce a 500.
 */
async function loadCorpus(): Promise<{ sources: CorpusStat[]; totalPassages: number }> {
  try {
    return await getCorpusStats();
  } catch (err) {
    console.error("[corpus] unavailable:", err instanceof Error ? err.message : String(err));
    return { sources: [], totalPassages: 0 };
  }
}

export default async function HomePage() {
  const { sources, totalPassages } = await loadCorpus();
  return (
    // DocSearchApp reads the URL for shareable result links, which requires a
    // Suspense boundary.
    <Suspense fallback={null}>
      <DocSearchApp sources={sources} totalPassages={totalPassages} />
    </Suspense>
  );
}
