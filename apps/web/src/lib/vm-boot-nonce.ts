export function nonEchoNonceCommand(nonce: string) {
  const octal = Array.from(new TextEncoder().encode(nonce), (byte) =>
    `\\${byte.toString(8).padStart(3, "0")}`,
  ).join("");
  if (!octal || octal.includes(nonce)) {
    throw new Error("could not encode nonce command");
  }
  // The shell echo contains octal escapes; only printf writes the nonce.
  return `printf '${octal}\\n'`;
}

export function scanRemoteTerminalFrame(input: {
  needle: string;
  previousTail: string;
  payload: string | Uint8Array;
}) {
  const frame =
    typeof input.payload === "string"
      ? input.payload
      : new TextDecoder().decode(input.payload);
  const combined = `${input.previousTail}${frame}`;
  const tailLength = Math.max(0, input.needle.length - 1);
  return {
    matches: combined.includes(input.needle),
    nextTail: tailLength === 0 ? "" : combined.slice(-tailLength),
  };
}

