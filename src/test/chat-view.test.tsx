import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatView } from "../components/vector/ChatView";
import type { Chat } from "../lib/store";
import type { ProjectOverviewData, FileSummaryData, SummaryResult } from "../lib/api";

const mockFileSummary: FileSummaryData = {
  tldr: "A utility file for calculations.",
  purpose: "Provides mathematical utility helpers.",
  language: "typescript",
  key_functions: [
    {
      name: "calcSum",
      signature: "calcSum(a: number, b: number): number",
      summary: "Sums two numbers.",
      line_start: 1,
      line_end: 3,
    },
  ],
  dependencies: ["math"],
  gotchas: [],
};

const mockProjectOverview: ProjectOverviewData = {
  name: "Sample App",
  tldr: "A modern React web application.",
  purpose: "Demonstrates complete project summarization flow.",
  tech_stack: [{ language: "TypeScript", file_count: 5, role: "Frontend" }],
  architecture: "Single page app with client-side routing.",
  directory_map: [{ path: "src", role: "Source code" }],
  entry_points: [{ path: "src/main.tsx", why: "Main entry" }],
  data_flow: "User interactions update state store.",
  how_to_run: { commands: ["npm install", "npm run dev"], inferred: false },
  start_here: [{ path: "src/main.tsx", reason: "Application bootstrap" }],
  gotchas: ["Requires Node.js 18+"],
  files_summarised: 5,
  files_skipped: 0,
  model: "gemma4:e4b",
  files: [
    {
      path: "src/main.tsx",
      summary: mockFileSummary,
      cached: false,
    },
  ],
};

describe("ChatView component resilience and rendering", () => {
  it("renders a standard file summary result card", () => {
    const chat: Chat = {
      id: "chat-1",
      title: "File summary",
      messages: [
        {
          id: "m-1",
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          summaryResult: {
            id: 1,
            summary: mockFileSummary,
            cached: false,
            model: "gemma4:e4b",
            provider: "ollama",
          },
          model: "gemma4:e4b",
          provider: "ollama",
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sources: [],
    };

    render(<ChatView chat={chat} busy={false} />);

    expect(screen.getByText("A utility file for calculations.")).toBeInTheDocument();
    expect(screen.getByText("calcSum")).toBeInTheDocument();
  });

  it("renders a project overview result card via projectResult", () => {
    const chat: Chat = {
      id: "chat-2",
      title: "Project summary",
      messages: [
        {
          id: "m-2",
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          projectResult: mockProjectOverview,
          model: "gemma4:e4b",
          provider: "ollama",
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sources: [],
    };

    render(<ChatView chat={chat} busy={false} />);

    expect(screen.getByText("Sample App")).toBeInTheDocument();
    expect(screen.getByText("A modern React web application.")).toBeInTheDocument();
    expect(screen.getByText("Single page app with client-side routing.")).toBeInTheDocument();
  });

  it("renders a project overview even if placed in summaryResult (legacy mismatch fallback)", () => {
    const chat: Chat = {
      id: "chat-3",
      title: "Legacy mismatch project summary",
      messages: [
        {
          id: "m-3",
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          summaryResult: {
            id: 2,
            summary: mockProjectOverview as unknown as FileSummaryData,
            cached: false,
            model: "gemma4:e4b",
            provider: "ollama",
          },
          model: "gemma4:e4b",
          provider: "ollama",
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sources: [],
    };

    render(<ChatView chat={chat} busy={false} />);

    expect(screen.getByText("Sample App")).toBeInTheDocument();
    expect(screen.getByText("A modern React web application.")).toBeInTheDocument();
  });

  it("renders UnreadableSummaryCard without crashing when given unreadable data", () => {
    const chat: Chat = {
      id: "chat-4",
      title: "Corrupt summary",
      messages: [
        {
          id: "m-4",
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          summaryResult: {
            id: 3,
            summary: { invalid: true } as unknown as FileSummaryData,
            cached: false,
            model: "gemma4:e4b",
            provider: "ollama",
          },
          model: "gemma4:e4b",
          provider: "ollama",
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sources: [],
    };

    render(<ChatView chat={chat} busy={false} />);

    expect(screen.getByText(/This summary is in an old or unreadable format/i)).toBeInTheDocument();
  });
});
