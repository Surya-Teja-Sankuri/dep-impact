import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { printReport } from "../src/reporter/index.js";
import type { ScoreResult } from "../src/scorer/index.js";

function baseResult(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    packageName: "pkg",
    currentVersion: "1.0.0",
    targetVersion: "2.0.0",
    overall: "NONE",
    files: [],
    totalFilesAffected: 0,
    totalFilesScanned: 0,
    strategy: "type-diff",
    ...overrides,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

function loggedLines(): string[] {
  return logSpy.mock.calls.map((call) => String(call[0]));
}

describe("printReport - json mode", () => {
  it("prints a single valid JSON blob containing the full result", () => {
    const result = baseResult({
      overall: "HIGH",
      files: [
        {
          file: path.resolve(process.cwd(), "src", "api", "client.ts"),
          risk: "HIGH",
          reasons: ["create was removed"],
          affectedMethods: ["pkg.create"],
        },
      ],
      totalFilesAffected: 1,
    });

    printReport(result, true, false);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(loggedLines()[0]);
    expect(parsed.overall).toBe("HIGH");
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].risk).toBe("HIGH");
    expect(parsed.files[0].reasons).toEqual(["create was removed"]);
  });

  it("always uses forward-slash paths in JSON output regardless of the OS path separator", () => {
    const nestedFile = path.resolve(process.cwd(), "src", "api", "client.ts");
    const result = baseResult({
      files: [{ file: nestedFile, risk: "LOW", reasons: [], affectedMethods: [] }],
    });

    printReport(result, true, false);

    const parsed = JSON.parse(loggedLines()[0]);
    expect(parsed.files[0].file).toBe("src/api/client.ts");
    expect(parsed.files[0].file).not.toContain("\\");
  });

  it("does not apply color codes to json output", () => {
    const result = baseResult({ overall: "HIGH" });
    printReport(result, true, false);

    const raw = loggedLines()[0];
    // eslint-disable-next-line no-control-regex
    expect(raw).not.toMatch(/\[/);
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("printReport - human-readable mode", () => {
  it("prints a NONE message when no files are affected", () => {
    const result = baseResult({ overall: "NONE", files: [] });
    printReport(result, false, false);

    const lines = loggedLines();
    expect(lines.some((line) => line.includes("No breaking changes detected"))).toBe(true);
    expect(lines.some((line) => line.includes("pkg  1.0.0 → 2.0.0"))).toBe(true);
  });

  it("lists only affected (non-NONE) files, with method names and the first reason", () => {
    const affectedFile = path.resolve(process.cwd(), "src", "client.ts");
    const untouchedFile = path.resolve(process.cwd(), "src", "unused.ts");
    const result = baseResult({
      overall: "MEDIUM",
      totalFilesAffected: 1,
      files: [
        {
          file: affectedFile,
          risk: "MEDIUM",
          reasons: ["first reason", "second reason"],
          affectedMethods: ["pkg.create"],
        },
        { file: untouchedFile, risk: "NONE", reasons: [], affectedMethods: [] },
      ],
    });

    printReport(result, false, false);

    const lines = loggedLines();
    const relAffected = path.relative(process.cwd(), affectedFile);
    const relUntouched = path.relative(process.cwd(), untouchedFile);

    expect(lines.some((line) => line.includes(relAffected))).toBe(true);
    expect(lines.some((line) => line.includes(relUntouched))).toBe(false);
    expect(lines.some((line) => line.includes("methods: pkg.create"))).toBe(true);
    expect(lines.some((line) => line.includes("first reason"))).toBe(true);
    expect(lines.some((line) => line.includes("second reason"))).toBe(false);
  });

  it("shows every reason when verbose is true, not just the first", () => {
    const result = baseResult({
      overall: "HIGH",
      totalFilesAffected: 1,
      files: [
        {
          file: path.resolve(process.cwd(), "src", "client.ts"),
          risk: "HIGH",
          reasons: ["first reason", "second reason"],
          affectedMethods: ["pkg.create"],
        },
      ],
    });

    printReport(result, false, true);

    const lines = loggedLines();
    expect(lines.some((line) => line.includes("first reason"))).toBe(true);
    expect(lines.some((line) => line.includes("second reason"))).toBe(true);
  });

  it("pluralizes the affected-files summary correctly", () => {
    const oneFile = baseResult({ totalFilesAffected: 1, overall: "LOW", files: [] });
    printReport(oneFile, false, false);
    expect(loggedLines().some((line) => line.includes("1 file may need changes"))).toBe(true);

    logSpy.mockClear();

    const twoFiles = baseResult({ totalFilesAffected: 2, overall: "LOW", files: [] });
    printReport(twoFiles, false, false);
    expect(loggedLines().some((line) => line.includes("2 file(s) may need changes"))).toBe(true);
  });

  it("prints the correct strategy message per strategy", () => {
    printReport(baseResult({ strategy: "type-diff" }), false, false);
    expect(
      loggedLines().some((line) => line.includes("Analysis based on type definitions (accurate)")),
    ).toBe(true);

    logSpy.mockClear();

    printReport(baseResult({ strategy: "regex-heuristics" }), false, false);
    expect(
      loggedLines().some((line) => line.includes("Analysis based on changelog heuristics (estimated)")),
    ).toBe(true);

    logSpy.mockClear();

    printReport(baseResult({ strategy: "none" }), false, false);
    expect(
      loggedLines().some((line) => line.includes("manual review recommended")),
    ).toBe(true);
  });
});
