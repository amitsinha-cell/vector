import { describe, it, expect } from "vitest";

/**
 * Pure intent routing logic identical to src/routes/index.tsx
 */
export function determineSummariseIntent(params: {
  hasFolder: boolean;
  fileCount: number;
  text: string;
}): "project" | "file" {
  const { hasFolder, fileCount, text } = params;

  const isProject =
    hasFolder ||
    (fileCount >= 2 &&
      (!text.trim() ||
        /(explain|summaris|summariz|describ|overview|architect|structure|break down|analys|analyz|understand|project|codebase)/i.test(
          text,
        )));

  return isProject ? "project" : "file";
}

describe("Intent Routing", () => {
  it("routes any folder upload to project mode", () => {
    expect(determineSummariseIntent({ hasFolder: true, fileCount: 0, text: "" })).toBe("project");
    expect(
      determineSummariseIntent({
        hasFolder: true,
        fileCount: 0,
        text: "explain this project",
      }),
    ).toBe("project");
    expect(
      determineSummariseIntent({
        hasFolder: true,
        fileCount: 5,
        text: "what is the architecture?",
      }),
    ).toBe("project");
  });

  it("routes 2+ files with 'explain this project' to project mode", () => {
    expect(
      determineSummariseIntent({
        hasFolder: false,
        fileCount: 3,
        text: "explain this project",
      }),
    ).toBe("project");
    expect(
      determineSummariseIntent({
        hasFolder: false,
        fileCount: 2,
        text: "Give me an architectural overview of this codebase",
      }),
    ).toBe("project");
    expect(
      determineSummariseIntent({
        hasFolder: false,
        fileCount: 4,
        text: "",
      }),
    ).toBe("project");
  });

  it("keeps a single file in file mode even with 'explain this project'", () => {
    expect(
      determineSummariseIntent({
        hasFolder: false,
        fileCount: 1,
        text: "explain this project",
      }),
    ).toBe("file");
    expect(
      determineSummariseIntent({
        hasFolder: false,
        fileCount: 1,
        text: "summarise this file",
      }),
    ).toBe("file");
    expect(
      determineSummariseIntent({
        hasFolder: false,
        fileCount: 1,
        text: "",
      }),
    ).toBe("file");
  });

  it("keeps 2+ files in file mode when user asks a specific question not matching project keywords", () => {
    expect(
      determineSummariseIntent({
        hasFolder: false,
        fileCount: 2,
        text: "Fix the type error in user handler",
      }),
    ).toBe("file");
  });
});
