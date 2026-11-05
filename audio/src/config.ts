import type { Env } from "./env";

export const SERVICE_NAME = "mcp-audio";
export const SERVICE_VERSION = "0.1.0";
export const MCP_ROUTE = "/mcp";

/** Single upstream base for audio capabilities (api.imgkits.com). */
export const DEFAULT_API_BASE_URL = "https://api.imgkits.com";

export const DEFAULT_TANGOFLUX_CREATE_PATH = "/api/tangoflux/create";
export const DEFAULT_TANGOFLUX_RESULT_PATH = "/api/tangoflux/result";
export const DEFAULT_SPLEETER_CREATE_PATH = "/api/spleeter/create";
export const DEFAULT_SPLEETER_STATUS_PATH = "/api/spleeter/status";
export const DEFAULT_SPLEETER_RESULT_PATH = "/api/spleeter/result";
export const DEFAULT_WHISPER_CREATE_PATH = "/api/faster-whisper/create";
export const DEFAULT_WHISPER_RESULT_PATH = "/api/faster-whisper/result";
export const DEFAULT_QWEN_TTS_CREATE_PATH = "/api/qwen-tts/create";
export const DEFAULT_QWEN_TTS_STATUS_PATH = "/api/qwen-tts/status";
export const DEFAULT_QWEN_TTS_RESULT_PATH = "/api/qwen-tts/result";

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
export const DEFAULT_JOB_POLL_INTERVAL_MS = 4_000;

/** Expected `X-Access-Channel` value for requests forwarded by the gateway. */
export const GATEWAY_ACCESS_CHANNEL = "mcp-gateway";

export const MAX_PROMPT_CHARS = 2000;
export const MAX_AUDIO_URL_CHARS = 2048;
export const MAX_TEXT_CHARS = 5000;
export const MAX_REFER_AUDIO_TEXT_CHARS = 2000;
export const DEFAULT_DURATION_SECONDS = 10;
export const MIN_DURATION_SECONDS = 1;
export const MAX_DURATION_SECONDS = 30;
export const DEFAULT_STEPS = 25;
export const MIN_STEPS = 10;
export const MAX_STEPS = 100;
export const DEFAULT_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 55;
export const FROM_APP = "mcp-audio";

/**
 * Copyright / abuse gate shown in audio tool descriptions and results.
 */
export const COPYRIGHT_NOTICE =
  "Use only on material you own or are explicitly licensed/authorized to generate or remix. " +
  "Do not generate or redistribute copyrighted music, voice likenesses, or trademarked audio without permission. " +
  "Output URLs have a limited TTL and must not be abused for bulk scraping or redistribution. " +
  "Calls are rate-limited/metered by mcp-credit-gateway and require a valid sk_live_ key. " +
  "（仅处理自有或已获授权素材；禁止滥用生成/二创他人受版权保护的音乐或声音；输出有 TTL；调用限频。）";

/** Voice-clone specific authorization notice (required on clone_voice_tts). */
export const VOICE_CLONE_NOTICE =
  "Voice cloning is allowed ONLY for your own voice or a voice you have explicit written authorization to clone. " +
  "Unauthorized cloning of another person's voice is prohibited. Calls are rate-limited/metered. " +
  "（声音克隆仅限本人音色或已获书面授权的音色；禁止未授权克隆他人声音；调用限频。）";

export type BillableTool =
  | "text_to_sound_effect"
  | "separate_stems"
  | "transcribe_audio"
  | "generate_subtitles"
  | "text_to_speech"
  | "clone_voice_tts";

export const DEFAULT_COSTS: Record<BillableTool, number> = {
  text_to_sound_effect: 2,
  separate_stems: 3,
  transcribe_audio: 2,
  generate_subtitles: 2,
  text_to_speech: 2,
  clone_voice_tts: 3,
};

const COST_VARS: Record<BillableTool, keyof Env> = {
  text_to_sound_effect: "COST_TEXT_TO_SOUND_EFFECT",
  separate_stems: "COST_SEPARATE_STEMS",
  transcribe_audio: "COST_TRANSCRIBE_AUDIO",
  generate_subtitles: "COST_GENERATE_SUBTITLES",
  text_to_speech: "COST_TEXT_TO_SPEECH",
  clone_voice_tts: "COST_CLONE_VOICE_TTS",
};

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

/** Cost in credits for one tool call. `0` means the tool is free. */
export function costFor(env: Env, tool: BillableTool): number {
  return positiveInt(env[COST_VARS[tool]] as string | undefined, DEFAULT_COSTS[tool]);
}

export function apiBaseUrl(env: Env): string {
  return (env.API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

function pathFromEnv(value: string | undefined, fallback: string): string {
  const path = value?.trim();
  if (!path) return fallback;
  return path.startsWith("/") ? path : `/${path}`;
}

export function tangofluxCreatePath(env: Env): string {
  return pathFromEnv(env.TANGOFLUX_CREATE_PATH, DEFAULT_TANGOFLUX_CREATE_PATH);
}

export function tangofluxResultPath(env: Env): string {
  return pathFromEnv(env.TANGOFLUX_RESULT_PATH, DEFAULT_TANGOFLUX_RESULT_PATH);
}

export function spleeterCreatePath(env: Env): string {
  return pathFromEnv(env.SPLEETER_CREATE_PATH, DEFAULT_SPLEETER_CREATE_PATH);
}

export function spleeterStatusPath(env: Env): string {
  return pathFromEnv(env.SPLEETER_STATUS_PATH, DEFAULT_SPLEETER_STATUS_PATH);
}

export function spleeterResultPath(env: Env): string {
  return pathFromEnv(env.SPLEETER_RESULT_PATH, DEFAULT_SPLEETER_RESULT_PATH);
}

export function whisperCreatePath(env: Env): string {
  return pathFromEnv(env.WHISPER_CREATE_PATH, DEFAULT_WHISPER_CREATE_PATH);
}

export function whisperResultPath(env: Env): string {
  return pathFromEnv(env.WHISPER_RESULT_PATH, DEFAULT_WHISPER_RESULT_PATH);
}

export function qwenTtsCreatePath(env: Env): string {
  return pathFromEnv(env.QWEN_TTS_CREATE_PATH, DEFAULT_QWEN_TTS_CREATE_PATH);
}

export function qwenTtsStatusPath(env: Env): string {
  return pathFromEnv(env.QWEN_TTS_STATUS_PATH, DEFAULT_QWEN_TTS_STATUS_PATH);
}

export function qwenTtsResultPath(env: Env): string {
  return pathFromEnv(env.QWEN_TTS_RESULT_PATH, DEFAULT_QWEN_TTS_RESULT_PATH);
}

export function upstreamTimeoutMs(env: Env): number {
  return positiveInt(env.UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS);
}

export function jobPollIntervalMs(env: Env): number {
  return Math.max(200, positiveInt(env.JOB_POLL_INTERVAL_MS, DEFAULT_JOB_POLL_INTERVAL_MS));
}

/**
 * Direct workers.dev calls are a grey-release self-test escape hatch only.
 * Anything other than an explicit `ALLOW_DIRECT_MCP=1` fails closed.
 */
export function directMcpAllowed(env: Env): boolean {
  return env.ALLOW_DIRECT_MCP?.trim() === "1";
}
