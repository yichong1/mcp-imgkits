import {
  MINERU_CREATE_TIMEOUT_MS,
  MINERU_POLL_INTERVAL_MS,
  MINERU_POLL_TIMEOUT_MS,
  MINERU_RESULT_TIMEOUT_MS,
  type RuntimeDeps,
} from "./deps";
import { AppError, isRecord, sanitizeUpstreamMessage } from "./http";
import {
  normalizeTaskState,
  taskIdOf,
  unwrapGatewayData,
  UpstreamBusinessError,
} from "./result";

export interface MineruOptions {
  deps: RuntimeDeps;
  baseUrl: string;
  token: string;
  channel?: string;
  createTimeoutMs?: number;
  resultTimeoutMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export interface CreatedTask {
  taskId: string;
  backend: string | null;
}

export interface FinishedTask {
  taskId: string;
  data: Record<string, unknown>;
}

function baseUrlOf(options: MineruOptions): string {
  return options.baseUrl.trim().replace(/\/+$/, "");
}

function headersOf(options: MineruOptions): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
    accept: "application/json",
  };
  const channel = (options.channel ?? "").trim();
  if (channel) headers.channel = channel;
  return headers;
}

export async function createMineruTask(files: string[], options: MineruOptions): Promise<CreatedTask> {
  if (!options.token.trim()) {
    throw new AppError(503, "mineru_not_configured", "MinerU upstream is not configured.");
  }
  const baseUrl = baseUrlOf(options);
  if (!baseUrl) throw new AppError(503, "mineru_not_configured", "MinerU upstream is not configured.");

  let response: Response;
  try {
    response = await options.deps.fetchImpl(`${baseUrl}/create`, {
      method: "POST",
      headers: {
        ...headersOf(options),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        files,
        from_app: "mcp-doc-markdown-mcp",
        return_md: true,
        return_content_list: true,
        return_middle_json: false,
        return_model_output: false,
      }),
      signal: AbortSignal.timeout(options.createTimeoutMs ?? MINERU_CREATE_TIMEOUT_MS),
    });
  } catch {
    throw new AppError(502, "mineru_create_failed", "MinerU create request failed or timed out.");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AppError(
      502,
      "mineru_create_failed",
      `MinerU create failed (HTTP ${response.status}): ${messageFromPayload(payload)}`,
    );
  }

  let data: Record<string, unknown>;
  try {
    data = unwrapGatewayData(payload, "create");
  } catch (error) {
    if (error instanceof UpstreamBusinessError) {
      throw new AppError(502, "mineru_create_failed", error.message);
    }
    throw error;
  }

  const taskId = taskIdOf(data);
  if (!taskId || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
    throw new AppError(502, "mineru_task_id_missing", "MinerU create returned no usable task id.");
  }
  return {
    taskId,
    backend: typeof data.backend === "string" ? data.backend : null,
  };
}

export async function waitForMineruResult(taskId: string, options: MineruOptions): Promise<FinishedTask> {
  const baseUrl = baseUrlOf(options);
  const pollIntervalMs = options.pollIntervalMs ?? MINERU_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? MINERU_POLL_TIMEOUT_MS;
  const startedAt = options.deps.now();
  let lastKnownTaskId = taskId;

  while (options.deps.now() - startedAt < pollTimeoutMs) {
    const remaining = Math.max(1, pollTimeoutMs - (options.deps.now() - startedAt));
    let response: Response;
    try {
      response = await options.deps.fetchImpl(`${baseUrl}/result/${encodeURIComponent(taskId)}`, {
        method: "GET",
        headers: headersOf(options),
        signal: AbortSignal.timeout(Math.min(options.resultTimeoutMs ?? MINERU_RESULT_TIMEOUT_MS, remaining)),
      });
    } catch {
      await options.deps.sleep(pollIntervalMs);
      continue;
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      if (shouldRetryStatus(response.status) || isPendingPayload(payload)) {
        await options.deps.sleep(pollIntervalMs);
        continue;
      }
      throw new AppError(
        502,
        "mineru_result_failed",
        `MinerU result failed (HTTP ${response.status}): ${messageFromPayload(payload)}`,
      );
    }

    let data: Record<string, unknown>;
    try {
      data = unwrapGatewayData(payload, "result");
    } catch (error) {
      if (error instanceof UpstreamBusinessError) {
        if (error.pending) {
          await options.deps.sleep(pollIntervalMs);
          continue;
        }
        throw new AppError(502, "mineru_result_failed", error.message);
      }
      throw error;
    }

    const state = normalizeTaskState(data);
    if (state.state === "done") {
      return { taskId: state.taskId ?? lastKnownTaskId, data: state.data };
    }
    if (state.state === "failed") {
      throw new AppError(502, "mineru_task_failed", state.message);
    }

    lastKnownTaskId = taskIdOf(data) ?? lastKnownTaskId;
    await options.deps.sleep(pollIntervalMs);
  }

  throw new AppError(
    504,
    "mineru_timeout",
    `MinerU task did not finish within ${Math.round(pollTimeoutMs / 1000)} seconds (task ${taskId}).`,
  );
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isPendingPayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const message = String(payload.msg ?? payload.message ?? "").toLowerCase();
  return /pending|processing|running|not ready|in progress/.test(message);
}

function messageFromPayload(payload: unknown): string {
  if (!isRecord(payload)) return "no error details";
  return sanitizeUpstreamMessage(payload.msg ?? payload.message ?? payload.error, "no error details");
}
