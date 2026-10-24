import { describe, it, expect } from "vitest";
import {
  checkFileFilter,
  detectLanguage,
  filterFolderFiles,
  MAX_FILE_SIZE,
  MAX_FOLDER_FILES,
  MAX_TOTAL_SIZE,
} from "../lib/folderFilter";

// Helper to create mock File objects in Node/JSDOM environment
function createMockFile(name: string, size: number, type = "text/plain"): File {
  const file = new File(["x".repeat(Math.min(size, 1000))], name, { type });
  Object.defineProperty(file, "size", { value: size, configurable: true });
  return file;
}

describe("Folder Filter & Detection", () => {
  describe("detectLanguage", () => {
    it("detects languages correctly from filenames and extensions", () => {
      expect(detectLanguage("backend/main.py")).toBe("Python");
      expect(detectLanguage("src/index.ts")).toBe("TypeScript");
      expect(detectLanguage("src/App.tsx")).toBe("TypeScript React");
      expect(detectLanguage("client/main.js")).toBe("JavaScript");
      expect(detectLanguage("client/Component.jsx")).toBe("JavaScript React");
      expect(detectLanguage("index.html")).toBe("HTML");
      expect(detectLanguage("style.css")).toBe("CSS");
      expect(detectLanguage("Dockerfile")).toBe("Dockerfile");
      expect(detectLanguage("docker/Dockerfile.prod")).toBe("Dockerfile");
      expect(detectLanguage("Makefile")).toBe("Makefile");
      expect(detectLanguage("Cargo.toml")).toBe("TOML");
      expect(detectLanguage("server.go")).toBe("Go");
      expect(detectLanguage("lib.rs")).toBe("Rust");
      expect(detectLanguage("Main.java")).toBe("Java");
      expect(detectLanguage("query.sql")).toBe("SQL");
      expect(detectLanguage("deploy.sh")).toBe("Shell");
    });
  });

  describe("checkFileFilter", () => {
    it("skips excluded directories", () => {
      expect(checkFileFilter("node_modules/lodash/index.js", 500).skip).toBe(true);
      expect(checkFileFilter(".git/config", 200).skip).toBe(true);
      expect(checkFileFilter(".venv/lib/site.py", 500).skip).toBe(true);
      expect(checkFileFilter("dist/bundle.js", 1000).skip).toBe(true);
      expect(checkFileFilter("build/app.exe", 1000).skip).toBe(true);
      expect(checkFileFilter("app/__pycache__/main.cpython-312.pyc", 500).skip).toBe(true);
    });

    it("skips lockfiles", () => {
      expect(checkFileFilter("package-lock.json", 1000).skip).toBe(true);
      expect(checkFileFilter("frontend/package-lock.json", 1000).skip).toBe(true);
      expect(checkFileFilter("bun.lock", 500).skip).toBe(true);
      expect(checkFileFilter("Cargo.lock", 500).skip).toBe(true);
      expect(checkFileFilter("yarn.lock", 500).skip).toBe(true);
      expect(checkFileFilter("poetry.lock", 500).skip).toBe(true);
    });

    it("skips minified files and source maps", () => {
      expect(checkFileFilter("dist/app.min.js", 1000).skip).toBe(true);
      expect(checkFileFilter("bundle.js.map", 1000).skip).toBe(true);
      expect(checkFileFilter("styles/main.min.css", 500).skip).toBe(true);
    });

    it("skips binary, media and font files", () => {
      expect(checkFileFilter("assets/logo.png", 500).skip).toBe(true);
      expect(checkFileFilter("assets/font.woff2", 500).skip).toBe(true);
      expect(checkFileFilter("bin/program.exe", 500).skip).toBe(true);
      expect(checkFileFilter("app.wasm", 500).skip).toBe(true);
    });

    it("skips files exceeding 200 KB", () => {
      expect(checkFileFilter("huge_data.json", MAX_FILE_SIZE + 1).skip).toBe(true);
      expect(checkFileFilter("normal.py", MAX_FILE_SIZE).skip).toBe(false);
    });

    it("allows standard source code files", () => {
      expect(checkFileFilter("src/index.ts", 1500).skip).toBe(false);
      expect(checkFileFilter("backend/app/main.py", 2500).skip).toBe(false);
      expect(checkFileFilter("README.md", 1200).skip).toBe(false);
      expect(checkFileFilter("Dockerfile", 800).skip).toBe(false);
    });
  });

  describe("filterFolderFiles", () => {
    it("correctly calculates included, skipped, language breakdown and preview counts", () => {
      const mockRaw = [
        { file: createMockFile("main.py", 2000), relativePath: "my-app/backend/main.py" },
        { file: createMockFile("app.tsx", 3000), relativePath: "my-app/src/app.tsx" },
        { file: createMockFile("index.html", 1000), relativePath: "my-app/index.html" },
        { file: createMockFile("Dockerfile", 500), relativePath: "my-app/Dockerfile" },
        {
          file: createMockFile("package-lock.json", 5000),
          relativePath: "my-app/package-lock.json",
        },
        { file: createMockFile("bundle.min.js", 8000), relativePath: "my-app/dist/bundle.min.js" },
        { file: createMockFile("logo.png", 12000), relativePath: "my-app/public/logo.png" },
        { file: createMockFile("huge.sql", 300000), relativePath: "my-app/huge.sql" }, // > 200 KB
      ];

      const res = filterFolderFiles("my-app", mockRaw);

      expect(res.folderName).toBe("my-app");
      expect(res.included).toHaveLength(4);
      expect(res.skipped).toHaveLength(4);
      expect(res.totalBytes).toBe(6500);

      // Verify language counts
      expect(res.languageCounts["Python"]).toBe(1);
      expect(res.languageCounts["TypeScript React"]).toBe(1);
      expect(res.languageCounts["HTML"]).toBe(1);
      expect(res.languageCounts["Dockerfile"]).toBe(1);

      // Verify skipped reasons breakdown
      expect(res.skippedByReason["Lockfile"]).toBe(1);
      expect(res.skippedByReason["Ignored directory (dist)"]).toBe(1);
      expect(res.skippedByReason["Binary / media (.png)"]).toBe(1);
      expect(Object.keys(res.skippedByReason).some((k) => k.includes("Exceeds 200 KB"))).toBe(true);
    });

    it("caps at MAX_FOLDER_FILES (300 files)", () => {
      const mockRaw = Array.from({ length: 350 }, (_, i) => ({
        file: createMockFile(`file_${i}.js`, 100),
        relativePath: `proj/src/file_${i}.js`,
      }));

      const res = filterFolderFiles("proj", mockRaw);
      expect(res.included).toHaveLength(MAX_FOLDER_FILES);
      expect(res.skipped).toHaveLength(50);
      expect(res.trimmedReason).toContain("Capped at 300 files");
    });

    it("caps at MAX_TOTAL_SIZE (5 MB)", () => {
      // 30 files of 190 KB = 5.7 MB (each < 200 KB limit)
      const mockRaw = Array.from({ length: 30 }, (_, i) => ({
        file: createMockFile(`big_${i}.ts`, 190 * 1024),
        relativePath: `proj/big_${i}.ts`,
      }));

      const res = filterFolderFiles("proj", mockRaw);
      expect(res.totalBytes).toBeLessThanOrEqual(MAX_TOTAL_SIZE);
      expect(res.trimmedReason).toContain("5 MB total");
    });
  });
});
