const interval = 16384;

// If the origin sends ICY despite our request for plain audio, discard its tags.
export async function* audioBytes(source, upstreamInterval) {
  if (!upstreamInterval) {
    yield* source;
    return;
  }
  let audio = upstreamInterval;
  let skip = 0;
  for await (const chunk of source) {
    let pos = 0;
    while (pos < chunk.length) {
      if (audio) {
        const count = Math.min(audio, chunk.length - pos);
        yield chunk.subarray(pos, pos + count);
        audio -= count;
        pos += count;
      } else if (skip) {
        const count = Math.min(skip, chunk.length - pos);
        skip -= count;
        pos += count;
        if (!skip) audio = upstreamInterval;
      } else {
        skip = chunk[pos++] * 16;
        if (!skip) audio = upstreamInterval;
      }
    }
  }
}

export const metadataInterval = interval;

export function metadataBlock({ title, artwork }) {
  // A semicolon terminates an ICY field. Bound UTF-8 text below the 4080-byte limit.
  const safe = (text, limit) => Array.from(text.replace(/[;\p{Cc}]/gu, " ")).slice(0, limit).join("");
  const bytes = Buffer.from(`StreamTitle='${safe(title, 500)}';StreamUrl='${safe(artwork, 480)}';`);
  const units = Math.ceil(bytes.length / 16);
  const block = Buffer.alloc(1 + units * 16);
  block[0] = units;
  bytes.copy(block, 1);
  return block;
}

export async function* taggedAudio(source, getMetadata) {
  let remaining = interval;
  let last;
  for await (const chunk of source) {
    let pos = 0;
    while (pos < chunk.length) {
      const count = Math.min(remaining, chunk.length - pos);
      yield chunk.subarray(pos, pos + count);
      pos += count;
      remaining -= count;
      if (remaining === 0) {
        const current = getMetadata();
        yield current === last ? Buffer.from([0]) : metadataBlock(current);
        last = current;
        remaining = interval;
      }
    }
  }
}
