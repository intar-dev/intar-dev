/**
 * Page-level terminal reveal and benchmark gating.
 *
 * Two different clocks decide when a learner has a usable terminal:
 *
 * - the gateway `ready` frame is the transport truth. The PTY is open and the
 *   recording is intact, so the shell works now.
 * - the run projection is a poll. It can lag the gateway by a report interval.
 *
 * The primary metric counts a terminal the learner can see and use, so the
 * reveal must follow the transport truth, and the benchmark command must wait
 * until that shell is on screen. A warm socket behind a hidden container is
 * not a usable terminal and must never end the measurement.
 */

export interface TerminalTransportReport {
  /** The VM this transport belongs to. */
  vmId: string;
  /** Monotonic id of the transport attempt inside the terminal component. */
  attempt: number;
  /** True only while the gateway reported the ready target for this attempt. */
  ready: boolean;
}

/**
 * The report is keyed by VM, so a report from a previous VM or a superseded
 * attempt can not reveal the shell of the current one.
 */
export function isTransportReadyFor(
  report: TerminalTransportReport | null,
  selectedVmId: string | null,
): boolean {
  return Boolean(
    report?.ready === true &&
      selectedVmId !== null &&
      report.vmId === selectedVmId,
  );
}

/**
 * True when the shell must be on screen. Either readiness source may reveal
 * it: the transport truth reveals it as early as the gateway allows, and the
 * projection keeps the existing manual path working. A background run never
 * shows a shell, and a closed shell stays closed until the learner reopens it.
 */
export function shouldRevealTerminal(input: {
  transportReady: boolean;
  projectedReady: boolean;
  userWantsTerminal: boolean;
  runForeground: boolean;
}): boolean {
  if (!input.runForeground) return false;
  if (!input.userWantsTerminal) return false;
  return input.transportReady || input.projectedReady;
}

/**
 * The benchmark command proves a usable terminal, so it may only leave the
 * client when the gateway handshake is current AND the learner can see the
 * shell. Sending it while the container is hidden would record a success for
 * a terminal that was never presented, which is the measurement this gate
 * exists to prevent.
 */
export function shouldSendBenchmarkCommand(input: {
  gatewayReady: boolean;
  terminalVisible: boolean;
  connectionCurrent: boolean;
  commandAlreadySent: boolean;
}): boolean {
  return (
    input.gatewayReady &&
    input.terminalVisible &&
    input.connectionCurrent &&
    !input.commandAlreadySent
  );
}
