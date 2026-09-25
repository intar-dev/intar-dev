export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** Decodes canonical, unpadded base64url only; anything else throws. */
export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const decoded = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (encodeBase64Url(decoded) !== value) {
    throw new Error("non-canonical base64url");
  }
  return decoded;
}
