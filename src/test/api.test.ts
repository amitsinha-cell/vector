import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchHealth,
  fetchHistory,
  searchSummaries,
  exportSummary,
  fetchSettings,
  updateSettings,
  addWatch,
  listWatches,
  removeWatch,
  streamSummarise,
} from "../lib/api";

describe("API Client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetchHealth calls /health and returns parsed JSON", async () => {
    const mockHealth = {
      ollama: true,
      models: [{ name: "gemma4:e4b", size: 4000000000, mode: "default" }],
      defaults: {
        default: "gemma4:e4b",
        light: "gemma4:e2b",
        deep: "qwen2.5-coder:7b",
        num_ctx: 8192,
      },
      hosted_enabled: false,
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockHealth,
    });

    const res = await fetchHealth();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/health"),
      expect.any(Object),
    );
    expect(res.ollama).toBe(true);
    expect(res.models).toHaveLength(1);
    expect(res.defaults.default).toBe("gemma4:e4b");
  });

  it("fetchHistory calls /history with limit and offset query params", async () => {
    const mockHistory = [
      {
        id: 1,
        source_type: "file",
        source_ref: "app.py",
        file_path: "app.py",
        model: "gemma4:e4b",
        provider: "ollama",
        cached: false,
        created_at: "2026-10-22",
        tldr: "Main app module",
      },
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockHistory,
    });

    const res = await fetchHistory(10, 0);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/history?limit=10&offset=0"),
      expect.any(Object),
    );
    expect(res).toHaveLength(1);
    expect(res[0]?.source_ref).toBe("app.py");
  });

  it("searchSummaries encodes query string", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await searchSummaries("fastapi route");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/search?q=fastapi%20route"),
      expect.any(Object),
    );
  });

  it("exportSummary requests markdown by default", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: "# Header", filename: "test.md" }),
    });

    const res = await exportSummary(42);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/summaries/42/export?format=md"),
      expect.any(Object),
    );
    expect(res.filename).toBe("test.md");
  });

  it("addWatch sends path in POST body", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 5, path: "C:\\code", active: true }),
    });

    const res = await addWatch("C:\\code");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/watch"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "C:\\code" }),
      }),
    );
    expect(res.id).toBe(5);
  });

  it("streamSummarise processes SSE events correctly", async () => {
    const ssePayload =
      'event: progress\ndata: {"stage":"Parsing...","detail":"python"}\n\n' +
      'event: result\ndata: {"id":1,"summary":{"tldr":"A test summary","purpose":"Unit testing","language":"python","key_functions":[],"dependencies":[],"gotchas":[]},"cached":false,"model":"gemma4:e4b","provider":"ollama"}\n\n' +
      'event: done\ndata: {"cached":false}\n\n';

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(ssePayload));
        controller.close();
      },
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
    });

    const onProgress = vi.fn();
    const onResult = vi.fn();
    const onDone = vi.fn();

    await streamSummarise(
      { text: "print('hello')", filename: "hello.py" },
      { onProgress, onResult, onDone },
    );

    expect(onProgress).toHaveBeenCalledWith({ stage: "Parsing...", detail: "python" });
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        summary: expect.objectContaining({ tldr: "A test summary" }),
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("streamProjectSummarise normalizes project payload and calls onOverview", async () => {
    const ssePayload =
      'event: progress\ndata: {"stage":"Writing project overview...","detail":"Synthesising"}\n\n' +
      'event: overview\ndata: {"type":"project_result","id":16,"project":{"name":"TestProject","tldr":"Project TLDR","purpose":"Testing"},"model":"gemma4:e4b","provider":"ollama"}\n\n' +
      'event: done\ndata: {"success":true}\n\n';

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(ssePayload));
        controller.close();
      },
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
    });

    const onProgress = vi.fn();
    const onOverview = vi.fn();
    const onDone = vi.fn();

    const { streamProjectSummarise } = await import("../lib/api");
    await streamProjectSummarise(
      { name: "TestProject", files: [{ path: "main.py", content: "print(1)" }] },
      { onProgress, onOverview, onDone },
    );

    expect(onProgress).toHaveBeenCalledWith({
      stage: "Writing project overview...",
      detail: "Synthesising",
    });
    expect(onOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 16,
        overview: expect.objectContaining({ name: "TestProject", tldr: "Project TLDR" }),
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });
});
