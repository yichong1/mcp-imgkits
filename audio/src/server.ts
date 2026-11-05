import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  COPYRIGHT_NOTICE,
  DEFAULT_DURATION_SECONDS,
  DEFAULT_STEPS,
  DEFAULT_WAIT_SECONDS,
  MAX_AUDIO_URL_CHARS,
  MAX_PROMPT_CHARS,
  MAX_TEXT_CHARS,
  MAX_WAIT_SECONDS,
  SERVICE_NAME,
  SERVICE_VERSION,
  VOICE_CLONE_NOTICE,
  costFor,
} from "./config";
import type { ToolContext } from "./env";
import { toolErrorResult, toolJsonResult } from "./errors";
import { cloneVoiceTts, cloneVoiceTtsInputSchema } from "./tools/clone-voice-tts";
import { generateSubtitles, generateSubtitlesInputSchema } from "./tools/generate-subtitles";
import { separateStems, separateStemsInputSchema } from "./tools/separate-stems";
import { textToSoundEffect, textToSoundEffectInputSchema } from "./tools/text-to-sound-effect";
import { textToSpeech, textToSpeechInputSchema } from "./tools/text-to-speech";
import { transcribeAudio, transcribeAudioInputSchema } from "./tools/transcribe-audio";

function costLabel(cost: number): string {
  return cost === 0 ? "free" : `${cost} credit${cost === 1 ? "" : "s"}`;
}

export function createAudioServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });

  const soundCost = costFor(ctx.env, "text_to_sound_effect");
  server.registerTool(
    "text_to_sound_effect",
    {
      title: "Text to sound effect (TangoFlux)",
      description:
        `Generate a short sound-effect WAV from a text prompt via TangoFlux (async create + result poll). ` +
        `Pass \`prompt\` (<= ${MAX_PROMPT_CHARS} chars) with optional \`duration\` (default ${DEFAULT_DURATION_SECONDS}s) and \`steps\` (default ${DEFAULT_STEPS}); ` +
        `the call waits up to \`wait_seconds\` (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}) and returns \`job_id\` if still running. ` +
        `Poll by calling again with only \`job_id\`. Returns \`audio_url\` when done. ` +
        `Cost: ${costLabel(soundCost)} per call, charged by mcp-credit-gateway before forwarding. ` +
        `Compliance: ${COPYRIGHT_NOTICE}`,
      inputSchema: textToSoundEffectInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof textToSoundEffectInputSchema>) => {
      try {
        return toolJsonResult(await textToSoundEffect(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  const stemsCost = costFor(ctx.env, "separate_stems");
  server.registerTool(
    "separate_stems",
    {
      title: "Separate stems (Spleeter 2stems)",
      description:
        `Split a public audio URL into vocals + accompaniment stems via Spleeter 2stems (async create + result poll). ` +
        `Pass \`audio_url\` (http(s), <= ${MAX_AUDIO_URL_CHARS} chars) to start, or \`job_id\` to poll. ` +
        `Waits up to \`wait_seconds\` (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}). ` +
        `Returns \`vocals_url\`, \`accompaniment_url\`, and optional \`zip_url\` when done. ` +
        `Cost: ${costLabel(stemsCost)} per call, charged by mcp-credit-gateway before forwarding. ` +
        `Compliance / SSRF: only http(s) URLs; ${COPYRIGHT_NOTICE}`,
      inputSchema: separateStemsInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof separateStemsInputSchema>) => {
      try {
        return toolJsonResult(await separateStems(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  const asrCost = costFor(ctx.env, "transcribe_audio");
  server.registerTool(
    "transcribe_audio",
    {
      title: "Transcribe audio (Faster-Whisper)",
      description:
        `Transcribe a public audio URL via Faster-Whisper (async create + result poll; no status endpoint). ` +
        `Pass \`audio_url\` (http(s)) to start or \`job_id\` to poll. Optional \`language\`, \`response_format\` (simple|raw). ` +
        `Empty transcript is still success (no speech detected). ` +
        `Cost: ${costLabel(asrCost)} per call. Compliance / SSRF: ${COPYRIGHT_NOTICE}`,
      inputSchema: transcribeAudioInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof transcribeAudioInputSchema>) => {
      try {
        return toolJsonResult(await transcribeAudio(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  const subCost = costFor(ctx.env, "generate_subtitles");
  server.registerTool(
    "generate_subtitles",
    {
      title: "Generate subtitles (Faster-Whisper → SRT/VTT)",
      description:
        `Transcribe a public audio URL with Faster-Whisper and assemble SRT or VTT in the Worker. ` +
        `Pass \`audio_url\` to start or \`job_id\` to poll; \`format\` is \`srt\` (default) or \`vtt\`. ` +
        `Cost: ${costLabel(subCost)} per call. Compliance / SSRF: ${COPYRIGHT_NOTICE}`,
      inputSchema: generateSubtitlesInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof generateSubtitlesInputSchema>) => {
      try {
        return toolJsonResult(await generateSubtitles(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  const ttsCost = costFor(ctx.env, "text_to_speech");
  server.registerTool(
    "text_to_speech",
    {
      title: "Text to speech (Qwen-TTS)",
      description:
        `Synthesize speech from text via Qwen-TTS using a short \`refer_audio\` sample (http(s) URL). ` +
        `Pass \`text\` (<= ${MAX_TEXT_CHARS}) + \`refer_audio\` (+ recommended \`refer_audio_text\`) to start, or \`job_id\` to poll. ` +
        `voiceId library voices are not exposed this wave. ` +
        `Cost: ${costLabel(ttsCost)} per call. Compliance: ${COPYRIGHT_NOTICE}`,
      inputSchema: textToSpeechInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof textToSpeechInputSchema>) => {
      try {
        return toolJsonResult(await textToSpeech(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  const cloneCost = costFor(ctx.env, "clone_voice_tts");
  server.registerTool(
    "clone_voice_tts",
    {
      title: "Clone voice TTS (Qwen-TTS)",
      description:
        `Clone a voice from \`clone_audio_url\` and speak \`text\` via Qwen-TTS. ` +
        `Requires \`authorization_confirmed=true\` (own voice or written authorization). ` +
        `Pass \`text\` + \`clone_audio_url\` (+ recommended \`clone_audio_text\`) to start, or \`job_id\` to poll. ` +
        `Cost: ${costLabel(cloneCost)} per call. ` +
        `VOICE AUTHORIZATION: ${VOICE_CLONE_NOTICE} Also: ${COPYRIGHT_NOTICE}`,
      inputSchema: cloneVoiceTtsInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof cloneVoiceTtsInputSchema>) => {
      try {
        return toolJsonResult(await cloneVoiceTts(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  return server;
}
