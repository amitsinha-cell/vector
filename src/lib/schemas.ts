import { z } from "zod";
import type { FileSummaryData, ProjectOverviewData, RepoOverviewData } from "./api";

// ============================================================================
// File Summary Schema
// ============================================================================

export const keyFunctionSchema = z.object({
  name: z.string().default(""),
  signature: z.string().default(""),
  summary: z.string().default(""),
  line_start: z.number().nullable().default(null),
  line_end: z.number().nullable().default(null),
});

export const fileSummarySchema = z.object({
  tldr: z.string().default(""),
  purpose: z.string().default(""),
  language: z.string().default("unknown"),
  key_functions: z
    .array(keyFunctionSchema)
    .nullish()
    .transform((val) => val ?? []),
  dependencies: z
    .array(z.string())
    .nullish()
    .transform((val) => val ?? []),
  gotchas: z
    .array(z.string())
    .nullish()
    .transform((val) => val ?? []),
  _warning: z.string().optional(),
});

// ============================================================================
// Project Overview Schema
// ============================================================================

export const techStackItemSchema = z.object({
  language: z.string().default(""),
  file_count: z.number().default(0),
  role: z.string().default(""),
});

export const directoryMapItemSchema = z.object({
  path: z.string().default(""),
  role: z.string().default(""),
});

export const entryPointItemSchema = z.object({
  path: z.string().default(""),
  why: z.string().default(""),
});

export const howToRunSchema = z
  .object({
    commands: z
      .array(z.string())
      .nullish()
      .transform((val) => val ?? []),
    inferred: z.boolean().default(true),
  })
  .nullish()
  .transform((val) => val ?? { commands: [], inferred: false });

export const startHereItemSchema = z.object({
  path: z.string().default(""),
  reason: z.string().default(""),
});

export const projectOverviewSchema = z.object({
  name: z.string().default("Project"),
  tldr: z.string().default(""),
  purpose: z.string().default(""),
  tech_stack: z
    .array(techStackItemSchema)
    .nullish()
    .transform((val) => val ?? []),
  architecture: z.string().default(""),
  directory_map: z
    .array(directoryMapItemSchema)
    .nullish()
    .transform((val) => val ?? []),
  entry_points: z
    .array(entryPointItemSchema)
    .nullish()
    .transform((val) => val ?? []),
  data_flow: z.string().default(""),
  how_to_run: howToRunSchema,
  start_here: z
    .array(startHereItemSchema)
    .nullish()
    .transform((val) => val ?? []),
  gotchas: z
    .array(z.string())
    .nullish()
    .transform((val) => val ?? []),
  files_summarised: z.number().default(0),
  files_skipped: z.number().default(0),
  model: z.string().default("local"),
  files: z
    .array(
      z.object({
        path: z.string().default(""),
        summary: fileSummarySchema,
        cached: z.boolean().default(false),
      }),
    )
    .nullish()
    .transform((val) => val ?? []),
});

// ============================================================================
// Repo Overview Schema
// ============================================================================

export const repoOverviewSchema = z.object({
  repo_name: z.string().default(""),
  url: z.string().default(""),
  overview: z.string().default(""),
  start_here: z
    .array(startHereItemSchema)
    .nullish()
    .transform((val) => val ?? []),
  file_count: z.number().default(0),
  files: z
    .array(
      z.object({
        path: z.string().default(""),
        summary: fileSummarySchema,
        cached: z.boolean().default(false),
      }),
    )
    .nullish()
    .transform((val) => val ?? []),
});

// ============================================================================
// Normalization & Kind Inference Helpers
// ============================================================================

export type SummaryKind = "file" | "project" | "repo" | "unreadable";

export function inferSummaryKind(data: unknown, hintKind?: string | null): SummaryKind {
  if (!data || typeof data !== "object") {
    return "unreadable";
  }

  const obj = data as Record<string, unknown>;

  // Check hint or explicit kind property first
  const kind = (hintKind || obj["kind"] || obj["source_type"]) as string | undefined;

  if (kind === "project") {
    const res = projectOverviewSchema.safeParse(obj);
    if (res.success && (res.data.tldr || res.data.purpose || res.data.tech_stack.length > 0)) {
      return "project";
    }
  }

  if (kind === "repo") {
    const res = repoOverviewSchema.safeParse(obj);
    if (res.success && (res.data.overview || res.data.repo_name)) {
      return "repo";
    }
  }

  if (kind === "file" || kind === "project_file") {
    const res = fileSummarySchema.safeParse(obj);
    if (res.success && (res.data.tldr || res.data.purpose)) {
      return "file";
    }
  }

  // Structural shape heuristic if no kind or kind didn't match
  if ("tech_stack" in obj || "entry_points" in obj || "directory_map" in obj) {
    const res = projectOverviewSchema.safeParse(obj);
    if (res.success) return "project";
  }

  if ("repo_name" in obj || ("overview" in obj && !("tldr" in obj))) {
    const res = repoOverviewSchema.safeParse(obj);
    if (res.success) return "repo";
  }

  if ("key_functions" in obj || "language" in obj) {
    const res = fileSummarySchema.safeParse(obj);
    if (res.success) return "file";
  }

  // Fallback: check if it parses as FileSummary with at least a tldr or purpose
  const fileRes = fileSummarySchema.safeParse(obj);
  if (fileRes.success && (fileRes.data.tldr || fileRes.data.purpose)) {
    return "file";
  }

  // Fallback: check if it parses as ProjectOverview with at least a tldr or purpose
  const projRes = projectOverviewSchema.safeParse(obj);
  if (projRes.success && (projRes.data.tldr || projRes.data.purpose)) {
    return "project";
  }

  return "unreadable";
}

export function safeNormalizeFileSummary(data: unknown): FileSummaryData | null {
  if (!data || typeof data !== "object") return null;
  const res = fileSummarySchema.safeParse(data);
  if (res.success && (res.data.tldr || res.data.purpose)) {
    return res.data;
  }
  return null;
}

export function safeNormalizeProjectOverview(data: unknown): ProjectOverviewData | null {
  if (!data || typeof data !== "object") return null;
  const res = projectOverviewSchema.safeParse(data);
  if (res.success && (res.data.tldr || res.data.purpose || res.data.architecture)) {
    return res.data;
  }
  return null;
}

export function safeNormalizeRepoOverview(data: unknown): RepoOverviewData | null {
  if (!data || typeof data !== "object") return null;
  const res = repoOverviewSchema.safeParse(data);
  if (res.success && (res.data.overview || res.data.repo_name)) {
    return res.data;
  }
  return null;
}
