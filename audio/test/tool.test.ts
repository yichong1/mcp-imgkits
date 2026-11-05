import { describe, expect, it } from "vitest";
import { separateStems } from "../src/tools/separate-stems";
import { cloneVoiceTts } from "../src/tools/clone-voice-tts";
import { textToSpeech } from "../src/tools/text-to-speech";
import { transcribeAudio } from "../src/tools/transcribe-audio";
import { cuesToSrt, cuesToVtt, generateSubtitles } from "../src/tools/generate-subtitles";
import { textToSoundEffect } from "../src/tools/text-to-sound-effect";
import { jsonResponse, mockFetch, testCtx, testEnv, headerOf } from "./helpers";

describe("text_to_sound_effect", () => {
  it("creates, polls to done, returns audio_url", async () => {
    let polls = 0;
    const { calls } = mockFetch((url) => {
      if (url.endsWith("/create")) {
        return jsonResponse({
          code: 0,
          data: { jobId: "job-1", status: 0, status_str: "waiting", result: null, duration: 10, steps: 25 },
        });
      }
      polls += 1;
      if (polls < 2) {
        return jsonResponse({
          code: 0,
          data: { jobId: "job-1", status: 4, status_str: "processing", result: null, duration: 10, steps: 25 },
        });
      }
      return jsonResponse({
        code: 0,
        data: {
          jobId: "job-1",
          status: 10,
          status_str: "done",
          result: "https://cdn.example.net/tangoflux/job-1.wav",
          duration: 10,
          steps: 25,
        },
      });
    });

    const result = await textToSoundEffect(testCtx, {
      prompt: "gentle rain",
      duration: 10,
      steps: 25,
      wait_seconds: 5,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "done",
      job_id: "job-1",
      audio_url: "https://cdn.example.net/tangoflux/job-1.wav",
      duration: 10,
      steps: 25,
      charge: { charged: 2 },
    });
    expect(calls[0]?.body).toMatchObject({ prompt: "gentle rain", from_app: "mcp-audio" });
    expect(headerOf(calls[0]!, "authorization")).toBe("Bearer test-upstream-token");
  });

  it("rejects when UPSTREAM_API_TOKEN missing without calling upstream", async () => {
    const { fetchMock } = mockFetch(() => jsonResponse({}));
    await expect(
      textToSoundEffect(
        { ...testCtx, env: { ...testEnv, UPSTREAM_API_TOKEN: undefined } },
        { prompt: "rain", duration: 10, steps: 25, wait_seconds: 1 },
      ),
    ).rejects.toMatchObject({ code: "upstream_misconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls existing job_id without create", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({
        code: 0,
        data: {
          jobId: "job-9",
          status: 10,
          status_str: "done",
          result: "https://cdn.example.net/tangoflux/job-9.wav",
          duration: 8,
          steps: 20,
        },
      }),
    );
    const result = await textToSoundEffect(testCtx, {
      job_id: "job-9",
      duration: 10,
      steps: 25,
      wait_seconds: 2,
    });
    expect(result).toMatchObject({ ok: true, job_id: "job-9", created: false, status: "done" });
    expect(calls.every((c) => c.url.endsWith("/result"))).toBe(true);
  });
});


describe("separate_stems", () => {
  it("creates, polls to done, returns stem urls", async () => {
    let polls = 0;
    const { calls } = mockFetch((url) => {
      if (url.endsWith("/create")) {
        return jsonResponse({
          code: 0,
          data: { jobId: "stem-1", status: 0, status_str: "waiting", result: null, model: "2stems" },
        });
      }
      polls += 1;
      if (polls < 2) {
        return jsonResponse({
          code: 0,
          data: { jobId: "stem-1", status: 4, status_str: "processing", result: null },
        });
      }
      return jsonResponse({
        code: 0,
        data: {
          jobId: "stem-1",
          status: 10,
          status_str: "done",
          result: {
            vocals: "https://cdn.example.net/vocals.wav",
            accompaniment: "https://cdn.example.net/accompaniment.wav",
            zip_url: "https://cdn.example.net/stems.zip",
          },
        },
      });
    });

    const result = await separateStems(testCtx, {
      audio_url: "https://cdn.example.net/song.wav",
      wait_seconds: 5,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "done",
      job_id: "stem-1",
      vocals_url: "https://cdn.example.net/vocals.wav",
      accompaniment_url: "https://cdn.example.net/accompaniment.wav",
      zip_url: "https://cdn.example.net/stems.zip",
      charge: { charged: 3 },
    });
    expect(calls[0]?.body).toMatchObject({
      audio_url: "https://cdn.example.net/song.wav",
      from_app: "mcp-audio",
      model: "2stems",
    });
    expect(headerOf(calls[0]!, "authorization")).toBe("Bearer test-upstream-token");
  });

  it("rejects missing token without upstream call", async () => {
    const { fetchMock } = mockFetch(() => jsonResponse({}));
    await expect(
      separateStems(
        { ...testCtx, env: { ...testEnv, UPSTREAM_API_TOKEN: undefined } },
        { audio_url: "https://cdn.example.net/a.wav", wait_seconds: 1 },
      ),
    ).rejects.toMatchObject({ code: "upstream_misconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe("subtitle helpers", () => {
  it("formats srt and vtt", () => {
    const cues = [{ start: 0, end: 1.5, text: "Hello" }];
    expect(cuesToSrt(cues)).toContain("00:00:00,000 --> 00:00:01,500");
    expect(cuesToVtt(cues)).toContain("WEBVTT");
    expect(cuesToVtt(cues)).toContain("00:00:00.000 --> 00:00:01.500");
  });
});

describe("transcribe_audio", () => {
  it("creates and returns empty transcript as success", async () => {
    mockFetch((url) => {
      if (url.endsWith("/create")) {
        return jsonResponse({ code: 0, data: { jobId: "w1", status: 0, result: null } });
      }
      return jsonResponse({
        code: 0,
        data: { jobId: "w1", status: 10, status_str: "done", result: { segments: [] } },
      });
    });
    const result = await transcribeAudio(testCtx, {
      audio_url: "https://cdn.example.net/a.wav",
      response_format: "simple",
      wait_seconds: 2,
    });
    expect(result).toMatchObject({ ok: true, status: "done", text: "", segment_count: 0, charge: { charged: 2 } });
  });
});

describe("generate_subtitles", () => {
  it("builds srt from segments", async () => {
    mockFetch((url) => {
      if (url.endsWith("/create")) {
        return jsonResponse({ code: 0, data: { jobId: "w2", status: 0, result: null } });
      }
      return jsonResponse({
        code: 0,
        data: {
          jobId: "w2",
          status: 10,
          result: { segments: [{ id: 0, start: 0, end: 1, text: " Hi " }] },
        },
      });
    });
    const result = await generateSubtitles(testCtx, {
      audio_url: "https://cdn.example.net/a.wav",
      format: "srt",
      wait_seconds: 2,
    } as any);
    expect(result.status).toBe("done");
    expect(String(result.subtitles)).toContain("Hi");
    expect(result.charge).toMatchObject({ charged: 2 });
  });
});

describe("text_to_speech / clone_voice_tts gates", () => {
  it("rejects missing refer_audio before upstream", async () => {
    const { fetchMock } = mockFetch(() => jsonResponse({}));
    await expect(
      textToSpeech(testCtx, { text: "hello", wait_seconds: 1 } as any),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects clone without authorization_confirmed before charge/upstream", async () => {
    const { fetchMock } = mockFetch(() => jsonResponse({}));
    await expect(
      cloneVoiceTts(testCtx, {
        text: "hello",
        clone_audio_url: "https://cdn.example.net/v.wav",
        wait_seconds: 1,
      } as any),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates tts job with refer_audio", async () => {
    mockFetch((url) => {
      if (url.endsWith("/create")) {
        return jsonResponse({ code: 0, data: { jobId: "t1", status: 0, result: null } });
      }
      return jsonResponse({
        code: 0,
        data: { jobId: "t1", status: 10, status_str: "done", result: "https://cdn.example.net/out.mp3" },
      });
    });
    const result = await textToSpeech(testCtx, {
      text: "hello world",
      refer_audio: "https://cdn.example.net/ref.wav",
      refer_audio_text: "reference line",
      wait_seconds: 2,
    } as any);
    expect(result).toMatchObject({
      ok: true,
      status: "done",
      audio_url: "https://cdn.example.net/out.mp3",
      charge: { charged: 2 },
    });
  });
});
