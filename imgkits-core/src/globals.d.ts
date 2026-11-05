/** Minimal Worker runtime surface used by the entry and tests. */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props?: unknown;
}
