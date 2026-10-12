/**
 * Server-sent event parsing, shared by the route and the client.
 *
 * A chunk boundary can fall anywhere - mid-frame, mid-line, mid-JSON, even
 * mid-character - and the error that produces is silent: a token or two goes
 * missing and the answer appears to stop mid-sentence for no visible reason.
 * The rule that prevents it is the one at the bottom of parseFrames: never parse
 * a frame speculatively, always carry the tail forward.
 */

export type AnswerEvent =
  | { type: "token"; text: string }
  | { type: "done"; generatorId: string; generatorLabel: string; fellBack: boolean }
  | { type: "error"; message: string };

/** Serialise one event as an SSE frame. Server side. */
export function encodeFrame(event: AnswerEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Pull complete events out of a buffer, returning what is left.
 *
 * The caller keeps `rest` and prepends it to the next chunk. That is the whole
 * contract.
 */
export function parseFrames<T = AnswerEvent>(buffer: string): { events: T[]; rest: string } {
  const events: T[] = [];

  // A frame ends at a blank line. Splitting leaves the final element as
  // whatever came after the last blank line, which is either empty or an
  // incomplete frame - never a complete one, so it is always carried forward.
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";

  for (const frame of frames) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        events.push(JSON.parse(payload) as T);
      } catch {
        // Not valid JSON: drop this frame, not the stream. One malformed frame
        // must not end the answer.
      }
    }
  }

  return { events, rest };
}