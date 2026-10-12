/**
 * The fallback chain, and what runs when nothing is configured.
 *
 * A single provider is a single point of failure: a rate limit, an outage, or
 * a model being retired all take the feature down with no recourse. Generators
 * are tried in order and the first that produces text wins.
 *
 * Ordering is strongest-first. gpt-oss-20b leads because following a citation
 * format reliably is the whole task here, and it was the model measured to do
 * so. qwen3.8-27b is the second: it speaks to the same API and a similar free
 * tier, so it absorbs a per-model cap rather than a provider outage. They are
 * separate quota buckets on Groq, which is what makes the chain worth having -
 * falling back between two models on the same exhausted bucket would not.
 */
import { optionalEnv } from "../env";
import type { AnswerGenerator, PromptInput } from "./prompt";
import { createGroqGenerator } from "./groq";
import { composeAnswer } from "./compose";

/**
 * Models attempted in order. Overridable with ANSWER_MODELS so the chain can be
 * changed without a code change.
 */
export const DEFAULT_CHAIN = ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"];

export interface AnswerOutcome {
  generatorId: string;
  generatorLabel: string;
  /** True when the preferred generator was unavailable and something else ran. */
  fellBack: boolean;
  /** How far through the chain we got. 0 is the first choice. */
  attempt: number;
}

export function buildChain(): AnswerGenerator[] {
  const generators: AnswerGenerator[] = [];

  const groqKey = optionalEnv("GROQ_API_KEY", "");
  if (groqKey) {
    const configured = optionalEnv("ANSWER_MODELS", DEFAULT_CHAIN.join(","))
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);

    for (const model of configured) {
      generators.push(createGroqGenerator({ model, apiKey: groqKey }));
    }
  }

  return generators;
}

/**
 * Stream an answer, degrading through the chain.
 *
 * The chain is decided by the generator contract rather than by a separate
 * probe call. Each generator throws if the provider cannot serve the request
 * *before* emitting any token, so a failure is only ever a failure at zero
 * tokens - at which point trying the next one is free and invisible.
 *
 * An earlier version probed with a one-word generation first. It cost a second
 * full round trip on every request to discover something the real call would
 * have discovered for free, and it did not even work: the probe looked for
 * output tokens, and a reasoning model spends its budget in a channel the probe
 * was not reading, so a healthy generator was reported as broken and skipped.
 */
export async function streamWithFallback(
  prompt: PromptInput,
  onToken: (text: string) => void,
  signal?: AbortSignal,
): Promise<AnswerOutcome> {
  const chain = buildChain();
  let emitted = false;
  const guarded = (text: string) => {
    emitted = true;
    onToken(text);
  };

  for (const [attempt, generator] of chain.entries()) {
    try {
      await generator.stream(prompt, guarded, signal);
      return {
        generatorId: generator.id,
        generatorLabel: generator.label,
        fellBack: attempt > 0,
        attempt,
      };
    } catch (err) {
      // A dead connection mid-answer leaves partial text on screen. Falling back
      // now would splice two answers together, so rethrow and let the caller
      // render what arrived rather than pretend it was whole.
      if (emitted) throw err;

      if (signal?.aborted) throw err;
      console.warn(
        `[answer] ${generator.id} failed, trying the next one:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Nothing configured, or nothing reachable. Compose from the passages instead:
  // less fluent, and it cannot answer a question that needs synthesis - but
  // every sentence it emits is verbatim from the database, so it is never
  // wrong about the documentation.
  for (const chunk of composeAnswer(prompt)) onToken(chunk);
  return {
    generatorId: "compose",
    generatorLabel: "composed from the passages",
    fellBack: chain.length > 0,
    attempt: chain.length,
  };
}