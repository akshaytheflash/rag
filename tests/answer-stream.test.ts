import { describe, expect, it } from "vitest";
import { parseFrames } from "@/lib/answer/sse";

/**
 * These cover the client half of the answer stream, where a bug is silent:
 * drop a token or two and the answer appears to stop mid-sentence for no
 * visible reason. Every case here is a real chunk boundary the network can
 * produce at any moment.
 */
describe("parseFrames", () => {
  it("reads a complete frame", () => {
    const { events, rest } = parseFrames('data: {"type":"token","text":"hi"}\n\n');
    expect(events).toEqual([{ type: "token", text: "hi" }]);
    expect(rest).toBe("");
  });

  it("reads several frames from one chunk", () => {
    const { events } = parseFrames(
      'data: {"type":"token","text":"a"}\n\ndata: {"type":"token","text":"b"}\n\n',
    );
    expect(events).toHaveLength(2);
  });

  it("returns an incomplete trailing frame as rest, unparsed", () => {
    // The critical case. Parsing this speculatively throws the data away.
    const { events, rest } = parseFrames('data: {"type":"token","text":"a"}\n\ndata: {"type":"tok');
    expect(events).toHaveLength(1);
    expect(rest).toBe('data: {"type":"tok');
  });

  it("reassembles a frame split mid-JSON across two chunks", () => {
    const first = parseFrames('data: {"type":"token","text":"hel');
    expect(first.events).toHaveLength(0);

    const second = parseFrames(first.rest + 'lo"}\n\n');
    expect(second.events).toEqual([{ type: "token", text: "hello" }]);
  });

  it("reassembles a frame split at the blank-line boundary", () => {
    const first = parseFrames('data: {"type":"token","text":"a"}');
    expect(first.events).toHaveLength(0);

    const second = parseFrames(first.rest + "\n\n");
    expect(second.events).toHaveLength(1);
  });

  it("skips the [DONE] sentinel without emitting an event", () => {
    expect(parseFrames("data: [DONE]\n\n").events).toHaveLength(0);
  });

  it("ignores non-data lines", () => {
    expect(parseFrames("event: message\nid: 7\n\n").events).toHaveLength(0);
  });

  it("does not lose a frame that follows a malformed one", () => {
    // One bad frame must not end the answer.
    const { events } = parseFrames('data: {not json}\n\ndata: {"type":"done"}\n\n');
    expect(events).toEqual([{ type: "done" }]);
  });

  it("handles a chunk with no frame boundary at all", () => {
    const { events, rest } = parseFrames('data: {"type":"token"');
    expect(events).toHaveLength(0);
    expect(rest).toBe('data: {"type":"token"');
  });

  it("reassembles a multi-byte character split across chunks", () => {
    // A character split at the byte level is the same failure one layer down.
    const bytes = new TextEncoder().encode('data: {"type":"token","text":"→"}\n\n');
    const cut = bytes.indexOf(0xe2) + 1;
    const dec = new TextDecoder();
    const { events } = parseFrames(
      dec.decode(bytes.slice(0, cut), { stream: true }) + dec.decode(bytes.slice(cut), { stream: true }),
    );
    expect(events).toEqual([{ type: "token", text: "→" }]);
  });

  it("round-trips every event type through encode and parse", async () => {
    const { encodeFrame } = await import("@/lib/answer/sse");
    const stream =
      encodeFrame({ type: "token", text: "a" }) +
      encodeFrame({ type: "done", generatorId: "x", generatorLabel: "l", fellBack: false }) +
      encodeFrame({ type: "error", message: "no" });
    expect(parseFrames(stream).events).toHaveLength(3);
  });
});