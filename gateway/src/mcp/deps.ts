export interface RuntimeDeps {
  fetchImpl: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  randomId: () => string;
}

export function defaultDeps(): RuntimeDeps {
  return {
    fetchImpl: (input, init) => globalThis.fetch(input, init),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => Date.now(),
    randomId: () => `job_${crypto.randomUUID()}`,
  };
}

export const MINERU_CREATE_TIMEOUT_MS = 30_000;
export const MINERU_RESULT_TIMEOUT_MS = 15_000;
export const MINERU_POLL_INTERVAL_MS = 2_000;
export const MINERU_POLL_TIMEOUT_MS = 75_000;
