import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = resolve(import.meta.dirname, "../src");

const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+["']node:[^"']+["']/,
  /from\s+["'](fs|path|crypto|http|https|url|util|stream|os|net|tls|zlib|child_process|buffer|process)["']/,
  /import\s*\(\s*["']node:[^"']+["']\s*\)/,
  /\brequire\s*\(/,
  /\bprocess\./,
  /\bBuffer\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
];

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

describe("@facet/worker Web Standard purity", () => {
  it("contains zero Node-only imports or globals in packages/worker/src/**", () => {
    const files = collectTsFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        expect(pattern.test(content), `Forbidden Node pattern ${pattern} found in ${file}`).toBe(
          false,
        );
      }
    }
  });
});
