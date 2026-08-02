/**
 * Serializes provider mutations for one Durable Object instance. D1 remains
 * canonical, so this queue intentionally has no durable state of its own.
 */
export class SerializedOperationQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
