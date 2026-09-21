/**
 * Minimal, dependency-free Server-Sent Events reader (contract §7 SSE stream).
 *
 * Consumes a `ReadableStream<Uint8Array>` (from a `fetch` response) and yields
 * `{ event, data }` frames. Handles `\r\n` / `\n` / `\r` line endings, multi-line
 * `data:` fields, comment/keep-alive lines, and chunks that split a frame in the
 * middle (including a CRLF pair arriving across two chunks). `event:` defaults
 * to `"message"`.
 */

export interface SseFrame {
  /** The `event:` name (`"message"` when absent). */
  event: string;
  /** Concatenated `data:` payload (raw string; parse JSON at the call site). */
  data: string;
  /** The `id:` field when present. */
  id?: string;
}

/** Frame buffer that folds parsed SSE fields into a {@link SseFrame}. */
class FrameAccumulator {
  private eventName = "message";
  private eventId: string | undefined;
  private dataLines: string[] = [];
  private sawField = false;

  feed(line: string): SseFrame | undefined {
    if (line === "") {
      if (!this.sawField) return undefined; // ignore stray blank lines
      const frame: SseFrame = { event: this.eventName, data: this.dataLines.join("\n") };
      if (this.eventId !== undefined) frame.id = this.eventId;
      this.reset();
      return frame;
    }
    if (line.startsWith(":")) return undefined; // comment / keep-alive

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        this.eventName = value;
        this.sawField = true;
        break;
      case "data":
        this.dataLines.push(value);
        this.sawField = true;
        break;
      case "id":
        this.eventId = value;
        this.sawField = true;
        break;
      case "retry":
        this.sawField = true;
        break;
      default:
        break; // unknown field ignored per SSE spec
    }
    return undefined;
  }

  /** Emit a dangling buffered frame when the stream closes without a blank line. */
  flush(): SseFrame | undefined {
    if (!this.sawField || (this.dataLines.length === 0 && this.eventName === "message")) return undefined;
    const frame: SseFrame = { event: this.eventName, data: this.dataLines.join("\n") };
    if (this.eventId !== undefined) frame.id = this.eventId;
    this.reset();
    return frame;
  }

  private reset() {
    this.eventName = "message";
    this.eventId = undefined;
    this.dataLines = [];
    this.sawField = false;
  }
}

/**
 * Pull the next complete line out of `buffer`, mutating `buffer`.
 * Returns `undefined` when no full line is buffered yet. A trailing lone `\r`
 * is held back (it may be the first half of a `\r\n` arriving next chunk)
 * unless `final` is set.
 */
function takeLine(buffer: string, final: boolean): { line: string; rest: string } | undefined {
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === "\n") {
      return { line: buffer.slice(0, i), rest: buffer.slice(i + 1) };
    }
    if (ch === "\r") {
      const next = buffer[i + 1];
      if (next === "\n") return { line: buffer.slice(0, i), rest: buffer.slice(i + 2) };
      if (next === undefined && !final) return undefined; // wait to see if \n follows
      return { line: buffer.slice(0, i), rest: buffer.slice(i + 1) };
    }
  }
  return undefined;
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const acc = new FrameAccumulator();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });

      let advanced = false;
      for (;;) {
        const taken = takeLine(buffer, done === true);
        if (!taken) break;
        buffer = taken.rest;
        advanced = true;
        const frame = acc.feed(taken.line);
        if (frame) yield frame;
      }
      if (!advanced && done) break;
      if (done) break;
    }

    buffer += decoder.decode();
    // Any bytes still buffered after the stream ends are one final line.
    if (buffer.length > 0) {
      const frame = acc.feed(buffer);
      if (frame) yield frame;
    }
    const trailing = acc.flush();
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}
