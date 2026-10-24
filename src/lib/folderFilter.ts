/**
 * Folder filter and preview utilities for Vector Phase 2.
 * Enforces client-side security, directory skips, lockfile skips,
 * binary exclusions, size limits (200 KB per file, 300 files max, 5 MB total max),
 * and language detection.
 */

export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".idea",
  ".vscode",
  "vendor",
  "coverage",
  "bin",
  "obj",
  ".turbo",
  ".cache",
]);

export const LOCKFILES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "poetry.lock",
  "cargo.lock",
  "pnpm-lock.yaml",
  "gemfile.lock",
  "composer.lock",
  "pipfile.lock",
]);

export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".pyc",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mp3",
  ".wav",
  ".mov",
  ".avi",
]);

export const MAX_FILE_SIZE = 200 * 1024; // 200 KB
export const MAX_FOLDER_FILES = 300;
export const MAX_TOTAL_SIZE = 5 * 1024 * 1024; // 5 MB

export function detectLanguage(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const filename = norm.split("/").pop() || "";
  const lower = filename.toLowerCase();

  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "Dockerfile";
  if (lower === "makefile" || lower === "gnumakefile") return "Makefile";
  if (lower === "cmakelists.txt") return "CMake";

  const ext = filename.includes(".") ? `.${filename.split(".").pop()?.toLowerCase()}` : "";

  switch (ext) {
    case ".py":
      return "Python";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "JavaScript";
    case ".jsx":
      return "JavaScript React";
    case ".ts":
    case ".mts":
    case ".cts":
      return "TypeScript";
    case ".tsx":
      return "TypeScript React";
    case ".go":
      return "Go";
    case ".rs":
      return "Rust";
    case ".java":
      return "Java";
    case ".c":
    case ".h":
      return "C";
    case ".cpp":
    case ".hpp":
    case ".cc":
    case ".cxx":
      return "C++";
    case ".cs":
      return "C#";
    case ".rb":
      return "Ruby";
    case ".php":
      return "PHP";
    case ".swift":
      return "Swift";
    case ".kt":
    case ".kts":
      return "Kotlin";
    case ".html":
    case ".htm":
      return "HTML";
    case ".css":
    case ".scss":
    case ".sass":
    case ".less":
      return "CSS";
    case ".json":
      return "JSON";
    case ".yaml":
    case ".yml":
      return "YAML";
    case ".toml":
      return "TOML";
    case ".md":
    case ".markdown":
      return "Markdown";
    case ".sql":
      return "SQL";
    case ".sh":
    case ".bash":
    case ".zsh":
      return "Shell";
    default:
      return ext ? ext.slice(1).toUpperCase() : "Text";
  }
}

export interface SkippedItem {
  path: string;
  reason: string;
  size: number;
}

export interface IncludedItem {
  file: File;
  relativePath: string;
  size: number;
  language: string;
}

export interface FolderFilterResult {
  folderName: string;
  included: IncludedItem[];
  skipped: SkippedItem[];
  skippedByReason: Record<string, number>;
  languageCounts: Record<string, number>;
  totalBytes: number;
  trimmedReason: string | null;
}

export function checkFileFilter(
  relativePath: string,
  size: number,
): { skip: boolean; reason?: string } {
  const norm = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = norm.split("/");
  const filename = parts[parts.length - 1] || "";
  const lowerName = filename.toLowerCase();

  // Directory skips
  for (let i = 0; i < parts.length - 1; i++) {
    const dir = parts[i]?.toLowerCase() || "";
    if (SKIP_DIRS.has(dir)) {
      return { skip: true, reason: `Ignored directory (${parts[i]})` };
    }
  }

  // Lockfile skips
  if (LOCKFILES.has(lowerName)) {
    return { skip: true, reason: "Lockfile" };
  }

  // Minified and source map files
  if (
    lowerName.endsWith(".min.js") ||
    lowerName.endsWith(".min.css") ||
    lowerName.endsWith(".map")
  ) {
    return { skip: true, reason: "Minified file or source map" };
  }

  // Binary and media files
  for (const ext of BINARY_EXTENSIONS) {
    if (lowerName.endsWith(ext)) {
      return { skip: true, reason: `Binary / media (${ext})` };
    }
  }

  // File size limit (200 KB)
  if (size > MAX_FILE_SIZE) {
    return { skip: true, reason: `Exceeds 200 KB (${Math.round(size / 1024)} KB)` };
  }

  return { skip: false };
}

export function filterFolderFiles(
  folderName: string,
  rawFiles: Array<{ file: File; relativePath: string }>,
): FolderFilterResult {
  const included: IncludedItem[] = [];
  const skipped: SkippedItem[] = [];
  const skippedByReason: Record<string, number> = {};
  const languageCounts: Record<string, number> = {};

  let totalBytes = 0;
  let trimmedReason: string | null = null;

  for (const item of rawFiles) {
    const { skip, reason } = checkFileFilter(item.relativePath, item.file.size);

    if (skip && reason) {
      skipped.push({
        path: item.relativePath,
        reason,
        size: item.file.size,
      });
      skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
      continue;
    }

    // Check count limit
    if (included.length >= MAX_FOLDER_FILES) {
      const trimReason = `Trimmed: Exceeded max ${MAX_FOLDER_FILES} files limit`;
      skipped.push({
        path: item.relativePath,
        reason: trimReason,
        size: item.file.size,
      });
      skippedByReason[trimReason] = (skippedByReason[trimReason] || 0) + 1;
      trimmedReason = `Capped at ${MAX_FOLDER_FILES} files (remaining files excluded)`;
      continue;
    }

    // Check total size limit
    if (totalBytes + item.file.size > MAX_TOTAL_SIZE) {
      const trimReason = `Trimmed: Exceeded max 5 MB total project limit`;
      skipped.push({
        path: item.relativePath,
        reason: trimReason,
        size: item.file.size,
      });
      skippedByReason[trimReason] = (skippedByReason[trimReason] || 0) + 1;
      trimmedReason = `Capped at 5 MB total (remaining files excluded)`;
      continue;
    }

    const lang = detectLanguage(item.relativePath);
    included.push({
      file: item.file,
      relativePath: item.relativePath,
      size: item.file.size,
      language: lang,
    });
    totalBytes += item.file.size;
    languageCounts[lang] = (languageCounts[lang] || 0) + 1;
  }

  return {
    folderName,
    included,
    skipped,
    skippedByReason,
    languageCounts,
    totalBytes,
    trimmedReason,
  };
}

/**
 * Recursively walk HTML5 DataTransferItem directory entries for drag-and-drop.
 */
interface FileEntryItem {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (f: File) => void, error?: () => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: FileEntryItem[]) => void, error?: () => void) => void;
  };
}

export async function getFilesFromDataTransfer(items: DataTransferItemList): Promise<{
  folderName: string;
  files: Array<{ file: File; relativePath: string }>;
}> {
  const result: Array<{ file: File; relativePath: string }> = [];
  let rootFolderName = "uploaded-folder";

  async function traverseEntry(entry: FileEntryItem, currentPath: string): Promise<void> {
    if (entry.isFile && entry.file) {
      await new Promise<void>((resolve) => {
        entry.file!(
          (f: File) => {
            result.push({
              file: f,
              relativePath: currentPath ? `${currentPath}/${entry.name}` : entry.name,
            });
            resolve();
          },
          () => resolve(),
        );
      });
    } else if (entry.isDirectory && entry.createReader) {
      const dirReader = entry.createReader();
      const readBatch = async (): Promise<FileEntryItem[]> => {
        return new Promise<FileEntryItem[]>((resolve) => {
          dirReader.readEntries(
            (entries: FileEntryItem[]) => resolve(entries),
            () => resolve([]),
          );
        });
      };

      let batch: FileEntryItem[];
      do {
        batch = await readBatch();
        for (const child of batch) {
          const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
          await traverseEntry(child, nextPath);
        }
      } while (batch.length > 0);
    }
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item?.kind === "file") {
      const entry = (
        item as DataTransferItem & {
          webkitGetAsEntry?: () => FileEntryItem | null;
        }
      ).webkitGetAsEntry?.();
      if (entry) {
        if (entry.isDirectory && rootFolderName === "uploaded-folder") {
          rootFolderName = entry.name;
        }
        await traverseEntry(entry, "");
      } else {
        const file = item.getAsFile();
        if (file) {
          result.push({
            file,
            relativePath: file.name,
          });
        }
      }
    }
  }

  return { folderName: rootFolderName, files: result };
}
