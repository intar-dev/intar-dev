export type TerminalProbeLifecycleEvent =
  | { type: "marker" }
  | { type: "exit"; code: number }
  | { type: "close" };

export type TerminalProbeLifecycleResult =
  | { status: "pending" }
  | { status: "passed" }
  | { status: "failed"; message: string };

export interface TerminalProbeLifecycleState {
  markerSeen: boolean;
  exitCode: number | null;
  result: TerminalProbeLifecycleResult;
}

export function initialTerminalProbeLifecycle(): TerminalProbeLifecycleState {
  return {
    markerSeen: false,
    exitCode: null,
    result: { status: "pending" },
  };
}

export function advanceTerminalProbeLifecycle(
  state: TerminalProbeLifecycleState,
  event: TerminalProbeLifecycleEvent,
): TerminalProbeLifecycleState {
  if (state.result.status !== "pending") return state;

  if (event.type === "marker") {
    return { ...state, markerSeen: true };
  }
  if (event.type === "exit") {
    return { ...state, exitCode: event.code };
  }
  if (!state.markerSeen) {
    return {
      ...state,
      result: {
        status: "failed",
        message: "terminal websocket closed before the probe marker",
      },
    };
  }
  if (state.exitCode === null) {
    return {
      ...state,
      result: {
        status: "failed",
        message: "terminal websocket closed without an exit acknowledgement",
      },
    };
  }
  if (state.exitCode !== 0) {
    return {
      ...state,
      result: {
        status: "failed",
        message: `terminal probe exited with code ${state.exitCode}`,
      },
    };
  }
  return { ...state, result: { status: "passed" } };
}

export function terminalProbeCommand(
  marker: string,
  forbiddenIps: string[],
  sameRunPeerIps: string[],
): string {
  const lines = [
    `printf '\\n${marker}_BEGIN\\n'`,
    "if command -v curl >/dev/null 2>&1; then",
    `  timeout 4 curl -fsS --connect-timeout 2 --max-time 3 http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1 && echo "${marker}:metadata=reachable" || echo "${marker}:metadata=blocked"`,
    "else",
    `  timeout 4 bash -lc ':</dev/tcp/169.254.169.254/80' >/dev/null 2>&1 && echo "${marker}:metadata=reachable" || echo "${marker}:metadata=blocked"`,
    "fi",
    "gateway=\"$(ip route show default 2>/dev/null | awk '/default/ { print $3; exit }')\"",
    'if [ -n "$gateway" ]; then',
    `  timeout 4 bash -lc ":</dev/tcp/$gateway/22" >/dev/null 2>&1 && echo "${marker}:host=reachable" || echo "${marker}:host=blocked"`,
    "else",
    `  echo "${marker}:host=unknown"`,
    "fi",
  ];

  forbiddenIps.forEach((ip, index) => {
    const variable = `forbidden_ip_${index}`;
    lines.push(`${variable}=${shellQuote(ip)}`);
    lines.push(
      `timeout 4 bash -lc ":</dev/tcp/\${${variable}}/22" >/dev/null 2>&1 && echo "${marker}:forbidden_${index}=reachable" || echo "${marker}:forbidden_${index}=blocked"`,
    );
  });

  sameRunPeerIps.forEach((ip, index) => {
    const variable = `peer_ip_${index}`;
    lines.push(`${variable}=${shellQuote(ip)}`);
    lines.push(
      `timeout 4 bash -lc ":</dev/tcp/\${${variable}}/22" >/dev/null 2>&1 && echo "${marker}:peer_${index}=reachable" || echo "${marker}:peer_${index}=blocked"`,
    );
  });

  // Let the shell exit naturally so Kino can drain and sync its recording.
  // Stargate then emits its final exit control frame and closes the socket.
  lines.push(`printf '${marker}_END\\n'`, "exit 0");
  return `${lines.join("\n")}\n`;
}

export function inspectReplayProbeOutput(
  cast: string,
  marker: string,
): { beginSeen: boolean; endSeen: boolean } {
  let output = "";
  for (const line of cast.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as unknown;
    if (
      Array.isArray(event) &&
      event[1] === "o" &&
      typeof event[2] === "string"
    ) {
      output += event[2];
    }
  }
  return {
    beginSeen: output.includes(`${marker}_BEGIN\r`),
    endSeen: output.includes(`${marker}_END\r`),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
