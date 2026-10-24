import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SummaryCard } from "../components/vector/SummaryCard";

describe("Phase 2 bug resilience", () => {
  it("does not throw when SummaryCard renders a project overview shape", () => {
    const projectSummaryShape = {
      tldr: "Sample project",
      purpose: "Testing",
      architecture: "Client-server",
      tech_stack: [{ language: "Python", file_count: 1, role: "Backend" }],
      entry_points: [{ path: "server.py", why: "Server" }],
      // key_functions is MISSING!
      // dependencies is MISSING!
      // gotchas is MISSING!
    };

    expect(() => {
      render(
        <SummaryCard
          result={{
            id: 24,
            cached: false,
            model: "gemma4:e4b",
            provider: "ollama",
            summary: projectSummaryShape as unknown as import("../lib/api").FileSummaryData,
          }}
        />,
      );
    }).not.toThrow();
  });
});
