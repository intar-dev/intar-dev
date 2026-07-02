import { ed25519 } from "@noble/curves/ed25519.js";

const textEncoder = new TextEncoder();
const OPENSSH_AUTH_MAGIC = textEncoder.encode("openssh-key-v1\0");

export interface SshEd25519KeyPair {
  publicKeyOpenssh: string;
  privateKeyOpenssh: string;
}

export function generateSshEd25519KeyPair(comment: string): SshEd25519KeyPair {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = ed25519.getPublicKey(seed);
  const publicKeyBlob = sshBytes([
    sshString("ssh-ed25519"),
    sshBinary(publicKey),
  ]);
  const publicKeyOpenssh = `ssh-ed25519 ${bytesToBase64(publicKeyBlob)} ${sanitizeComment(comment)}`;
  const privateKeyOpenssh = encodeOpenSshPrivateKey({
    seed,
    publicKey,
    publicKeyBlob,
    comment,
  });
  return { publicKeyOpenssh, privateKeyOpenssh };
}

function encodeOpenSshPrivateKey(input: {
  seed: Uint8Array;
  publicKey: Uint8Array;
  publicKeyBlob: Uint8Array;
  comment: string;
}): string {
  const check = crypto.getRandomValues(new Uint8Array(4));
  const keyBlock = withPrivateKeyPadding(
    sshBytes([
      check,
      check,
      sshString("ssh-ed25519"),
      sshBinary(input.publicKey),
      sshBinary(sshBytes([input.seed, input.publicKey])),
      sshString(sanitizeComment(input.comment)),
    ]),
  );
  const encoded = bytesToBase64(
    sshBytes([
      OPENSSH_AUTH_MAGIC,
      sshString("none"),
      sshString("none"),
      sshBinary(new Uint8Array()),
      uint32(1),
      sshBinary(input.publicKeyBlob),
      sshBinary(keyBlock),
    ]),
  );
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapBase64(encoded)}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function withPrivateKeyPadding(block: Uint8Array): Uint8Array {
  const paddingLength = (8 - (block.length % 8)) % 8;
  if (paddingLength === 0) {
    return block;
  }
  const padding = new Uint8Array(paddingLength);
  for (let index = 0; index < padding.length; index += 1) {
    padding[index] = index + 1;
  }
  return sshBytes([block, padding]);
}

function sshString(value: string): Uint8Array {
  return sshBinary(textEncoder.encode(value));
}

function sshBinary(value: Uint8Array): Uint8Array {
  return sshBytes([uint32(value.length), value]);
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function sshBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function wrapBase64(value: string): string {
  const lines: string[] = [];
  for (let index = 0; index < value.length; index += 70) {
    lines.push(value.slice(index, index + 70));
  }
  return lines.join("\n");
}

function sanitizeComment(value: string): string {
  return value.replace(/\s+/g, "-").replace(/[^A-Za-z0-9_.@:-]/g, "");
}
