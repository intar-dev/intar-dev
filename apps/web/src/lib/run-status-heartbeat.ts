/**
 * The run status socket's keep-alive. Cloudflare closes a WebSocket that
 * carries no data for a while, and a run can stay quiet for many minutes. The
 * host runtime answers the ping with a WebSocket auto-response, so it neither
 * wakes the Durable Object nor reaches webSocketMessage, which closes a status
 * socket on any other client frame.
 */
export const RUN_STATUS_PING = "run-status:ping";
export const RUN_STATUS_PONG = "run-status:pong";

/** A ping that is still unanswered at the next tick marks the socket dead. */
export const RUN_STATUS_HEARTBEAT_INTERVAL_MS = 30_000;
