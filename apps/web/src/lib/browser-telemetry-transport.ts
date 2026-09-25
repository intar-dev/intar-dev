import { FetchTransport, type TransportItem } from "@grafana/faro-web-sdk";

/**
 * Content blockers reject collector requests before they leave the browser.
 * The stock transport logs every rejected batch, so the first network failure
 * stops delivery for the rest of the page and later batches are dropped
 * quietly. HTTP errors still reach the internal logger.
 */
export class BlockableFetchTransport extends FetchTransport {
  private unreachable = false;

  override send(items: TransportItem[]): Promise<void> {
    if (this.unreachable) return Promise.resolve();
    return super.send(items);
  }

  override logError(...args: unknown[]): void {
    if (args.some((arg) => arg instanceof TypeError)) {
      this.unreachable = true;
      return;
    }
    super.logError(...args);
  }
}
