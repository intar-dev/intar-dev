// Canonical JSON: object keys sorted by UTF-8 byte order, no whitespace,
// undefined members dropped. Stored scenario documents and spec blobs are
// hashed over these bytes; `canonical_json` in intar-contracts writes the
// same.

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** Orders two strings by their UTF-8 bytes, as Rust orders `String`s. */
export function byteOrder(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < x.length && i < y.length; i += 1) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => byteOrder(a, b))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `sha256:` and the lowercase hex SHA-256 of `data` (text as UTF-8). */
export async function sha256Digest(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
