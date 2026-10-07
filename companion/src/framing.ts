// Chrome native messaging framing: a 4-byte little-endian length, then that many bytes of UTF-8 JSON.
// The same framing runs both ways on the host's stdin and stdout.

/** Chromium caps host -> browser messages at 1 MB. Browser -> host may reach 64 MB. */
export const MAX_REPLY_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_REPLY_BYTES) throw new Error(`reply of ${body.length} bytes exceeds the 1 MB native messaging cap`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/**
 * Parsed messages from a byte stream, in order, until EOF. A frame that is not JSON yields an Error in its
 * place, so the host can answer it and keep going; a truncated frame at EOF is dropped.
 */
export async function* readFrames(input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): AsyncGenerator<unknown> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of input) {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (length > MAX_REQUEST_BYTES) throw new Error(`frame of ${length} bytes exceeds ${MAX_REQUEST_BYTES}`);
      if (buffered.length < 4 + length) break;
      const body = buffered.subarray(4, 4 + length).toString('utf8');
      buffered = buffered.subarray(4 + length);
      try {
        yield JSON.parse(body);
      } catch (error) {
        yield error instanceof Error ? error : new Error(String(error));
      }
    }
  }
}
