/**
 * Groq-backed answer generator.
 *
 * OpenAI-compatible chat completions with stream:true, parsed as SSE. Runs on
 * Groq's hardware, so it costs nothing in function bundle or CPU budget - which
 * is why it is used in preference to running a model inside the function, where
 * even the smallest usable one would have added 131 MB to an 89 MB bundle
 * against a 250 MB limit.
 *
 * Two things about reasoning models had to be handled explicitly, both found by
 * measuring the raw stream rather than assuming:
 *
 *  1. They emit a `reasoning` channel before any `content`. Reading only
 *     content discarded the entire answer and looked like a broken integration.
 *  2. That reasoning is drawn from the *same* max_tokens budget. At 320 tokens
 *     gpt-oss-20b spent ~980 characters reasoning and had almost nothing left,
 *     so answers came back one clause long. `reasoning_effort: "low"` cuts the
 *     reasoning channel by roughly 5x, which is what makes a usable answer fit.
 */
import type { AnswerGenerator, PromptInput } from "./prompt";
import { buildPrompt } from "./prompt";

const BASE = "https://api.groq.com/openai/v1";

/**
 * Free-tier limits, read from Groq's own x-ratelimit-* headers on a live key:
 * 1,000 requests/min and 8,000 tokens/min on the chat models. An answer runs to
 * roughly 400 tokens including reasoning, so the ceiling is around 20 answers a
 * minute - well above what this deployment could serve anyway, given Vercel's
 * 1M invocations/month.
 */
const MAX_TOKENS = 1024;

/**
 * Reasoning budget, as low as Groq accepts.
 *
 * The measured difference between the default and `low` is ~980 characters of
 * reasoning versus ~190. Both are discarded; the point is that the low setting
 * leaves the rest of the budget for the answer itself.
 */
const REASONING_EFFORT = "low";

/** Low enough that the model quotes rather than elaborates. */
const TEMPERATURE = 0.1;

const SYSTEM_PROMPT =
  "You are a documentation assistant. Answer only from the documents you are given. " +
  "Quote them word for word rather than paraphrasing, and put the document number in square " +
  "brackets after each quoted sentence. Never invent an API, function or option that is not " +
  "in the documents. If the documents do not answer the question, say so.";

interface GroqOptions {
  model: string;
  apiKey: string;
}

export function createGroqGenerator({ model, apiKey }: GroqOptions): AnswerGenerator {
  return {
    id: `groq:${model}`,
    label: `${model} on Groq`,

    async stream(prompt: PromptInput, onToken: (text: string) => void, signal?: AbortSignal) {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal,
        body: JSON.stringify({
          model,
          stream: true,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          reasoning_effort: REASONING_EFFORT,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildPrompt(prompt) },
          ],
        }),
      });

      if (!res.ok || !res.body) {
        // Thrown before any token is emitted, which is exactly what lets the
        // chain fall back without having shown half an answer.
        const detail = await res.text().catch(() => "");
        throw new Error(`groq ${model} responded ${res.status}: ${detail.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line; the tail is a partial
          // frame and is kept for the next read.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (payload === "[DONE]") continue;

              try {
                const delta = JSON.parse(payload)?.choices?.[0]?.delta;
                // Only content is forwarded. The reasoning channel is the
                // model's private scratchpad: it is long, it is discarded, and
                // it is full of half-formed claims about the documentation that
                // would sit under the answer looking like findings.
                if (delta?.content) onToken(delta.content);
              } catch {
                // A frame we cannot parse is not worth killing the stream over.
              }
            }
          }
        }
      } catch (err) {
        // If the connection dies after text has already been shown, there is
        // nothing useful a fallback can do - so rethrow and let the caller
        // render what arrived.
        throw err;
      } finally {
        reader.cancel().catch(() => {});
      }
    },
  };
}