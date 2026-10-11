/**
 * Local text embeddings.
 *
 * Uses a sentence-transformer (all-MiniLM-L6-v2, int8 ONNX) executed on the
 * CPU via onnxruntime. This is a *retrieval encoder* that maps text to a
 * fixed-length vector - it does not generate, paraphrase or answer anything.
 * No network call is made at inference time; weights are read from ./models.
 */
import path from "node:path";
import { pipeline, env as transformersEnv, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 384);

/** MiniLM truncates at 256 word-pieces; longer input is cut, not rejected. */
export const MAX_TOKENS = 256;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function configureRuntime() {
  // Read weights from the committed ./models directory and never reach out to
  // the Hugging Face CDN at runtime. turbopackIgnore keeps this dynamic path
  // from pulling the whole working directory into the function bundle; the
  // model itself is included explicitly via outputFileTracingIncludes.
  transformersEnv.localModelPath = path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    "models",
  );
  transformersEnv.allowRemoteModels = false;
  transformersEnv.allowLocalModels = true;
}

export async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    configureRuntime();
    extractorPromise = pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: "q8",
    }) as Promise<FeatureExtractionPipeline>;
  }
  return extractorPromise;
}

/**
 * Embed one or more strings. Returns L2-normalised Float32 vectors, which is
 * what pgvector's cosine operators expect.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, {
    pooling: "mean",
    normalize: true,
  });

  const dims = output.dims as number[];
  const data = output.data as Float32Array;
  const vectorCount = dims[0];
  const vectorSize = dims[1];

  if (vectorSize !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIM}, model produced ${vectorSize}`,
    );
  }

  const out: number[][] = [];
  for (let i = 0; i < vectorCount; i++) {
    out.push(Array.from(data.subarray(i * vectorSize, (i + 1) * vectorSize)));
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  if (!vector) throw new Error("Embedding returned no vector");
  return vector;
}

/** Format a vector as the '[0.1,0.2,...]' literal pgvector expects. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
