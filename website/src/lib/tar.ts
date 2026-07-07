// Minimal ustar tar writer + gzip, enough to assemble scenario source
// bundles in the Worker (small text files, paths well under 100 chars).

export interface TarEntry {
  path: string;
  bytes: Uint8Array;
}

const BLOCK = 512;

function writeOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const text = value.toString(8).padStart(length - 1, "0");
  for (let i = 0; i < text.length; i++) {
    header[offset + i] = text.charCodeAt(i);
  }
  header[offset + length - 1] = 0;
}

function writeString(header: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    header[offset + i] = value.charCodeAt(i);
  }
}

export function buildTar(entries: TarEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const entry of entries) {
    if (encoder.encode(entry.path).length > 100) {
      throw new Error(`tar path too long: ${entry.path}`);
    }
    const header = new Uint8Array(BLOCK);
    writeString(header, 0, entry.path);
    writeOctal(header, 100, 8, 0o644); // mode
    writeOctal(header, 108, 8, 0); // uid
    writeOctal(header, 116, 8, 0); // gid
    writeOctal(header, 124, 12, entry.bytes.length); // size
    writeOctal(header, 136, 12, 0); // mtime
    header[156] = 0x30; // typeflag '0' regular file
    writeString(header, 257, "ustar");
    header[262] = 0;
    writeString(header, 263, "00");

    // Checksum: spaces while computing.
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, "0");
    writeString(header, 148, checksumText);
    header[154] = 0;
    header[155] = 0x20;

    chunks.push(header, entry.bytes);
    const remainder = entry.bytes.length % BLOCK;
    if (remainder !== 0) {
      chunks.push(new Uint8Array(BLOCK - remainder));
    }
  }

  // Two terminating zero blocks.
  chunks.push(new Uint8Array(BLOCK * 2));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
