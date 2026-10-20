/**
 * Minimal Server-Sent-Events reader for the search stream (§7, §116).
 *
 * `POST` + `ReadableStream` rather than `EventSource`: EventSource cannot send a body or the
 * tenant/auth headers, and the stream is a search request, not a public feed. The parser keeps
 * only what the contract defines (`event`, `data`); unknown events are surfaced so the caller can
 * log them instead of silently dropping a field the AI service added.
 */

export interface SseMessage {
  event: string;
  data: unknown;
}

/** Split a byte stream into SSE messages; UTF-8 safe across chunk boundaries. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // A message ends at a blank line; `\r\n` is legal too (§9.2 of the WHATWG event stream).
      for (;;) {
        const boundary = findBoundary(buffer);
        if (!boundary) break;
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const message = parseMessage(raw);
        if (message) yield message;
      }
    }
    buffer += decoder.decode();
    const tail = parseMessage(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function findBoundary(text: string): { index: number; length: number } | null {
  const lf = text.indexOf('\n\n');
  const crlf = text.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseMessage(raw: string): SseMessage | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // keep-alive comment
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  const text = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(text) as unknown };
  } catch {
    return { event, data: text };
  }
}
