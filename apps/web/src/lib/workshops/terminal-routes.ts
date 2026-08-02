const textEncoder = new TextEncoder();

export async function workshopBrowserTerminalRouteUsername(input: {
  workspaceId: string;
  actorUserId: string;
  vmId: string;
}): Promise<string> {
  return workshopTerminalRouteUsername({ ...input, mode: "browser" });
}

export async function workshopTerminalRouteUsername(input: {
  workspaceId: string;
  actorUserId: string;
  vmId: string;
  mode: "browser" | "native";
}): Promise<string> {
  const identity = `${input.workspaceId}\u0000${input.actorUserId}\u0000${input.vmId}\u0000${input.mode}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(identity)),
  );
  const digestHex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const vm = input.vmId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const suffix = input.mode === "browser" ? "web" : "native";
  return `workshop-${vm || "vm"}-${digestHex.slice(0, 32)}-${suffix}`;
}
