import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanProject } from "../src/scanner/index.js";

const PACKAGE_NAME = "somepkg";

let projectRoot: string;

function normalize(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function writeFile(relativePath: string, content: string): string {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dep-impact-scan-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("scanProject", () => {
  it("detects default-import and named-import property/call usages at the correct lines", async () => {
    const filePath = writeFile(
      "src/index.ts",
      [
        'import axios from "somepkg";',
        'import { get } from "somepkg";',
        "",
        "axios.create();",
        'get("/x");',
        "",
      ].join("\n"),
    );

    const result = await scanProject(PACKAGE_NAME, projectRoot);

    expect(result.packageName).toBe(PACKAGE_NAME);

    const createUsage = result.usages.find((u) => u.method === "somepkg.create");
    expect(createUsage).toBeDefined();
    expect(createUsage!.line).toBe(4);
    expect(normalize(createUsage!.file)).toBe(normalize(filePath));

    const getUsage = result.usages.find((u) => u.method === "somepkg.get");
    expect(getUsage).toBeDefined();
    expect(getUsage!.line).toBe(5);
    expect(normalize(getUsage!.file)).toBe(normalize(filePath));

    expect(result.usages).toHaveLength(2);
  });

  it("detects usage through CommonJS require() interop", async () => {
    writeFile(
      "src/index.ts",
      ['const somepkg = require("somepkg");', "somepkg.get();", ""].join("\n"),
    );

    const result = await scanProject(PACKAGE_NAME, projectRoot);

    const getUsage = result.usages.find((u) => u.method === "somepkg.get");
    expect(getUsage).toBeDefined();
    expect(getUsage!.line).toBe(2);
  });

  it("detects usage through require().default ESM/CJS interop unwrap", async () => {
    writeFile(
      "src/index.ts",
      [
        'const somepkg = require("somepkg").default;',
        "somepkg.get();",
        "",
      ].join("\n"),
    );

    const result = await scanProject(PACKAGE_NAME, projectRoot);

    const getUsage = result.usages.find((u) => u.method === "somepkg.get");
    expect(getUsage).toBeDefined();
    expect(getUsage!.line).toBe(2);
  });

  // KNOWN SOURCE BUG (not fixed here, per test-writing instructions): unwrapDefaultAccess()
  // only strips a direct `.default` PropertyAccessExpression. `require("pkg").default` needs
  // no parentheses so it unwraps fine, but `await import("pkg")` binds tighter than `.default`
  // (operator precedence), so writing this pattern requires parens:
  // `(await import("pkg")).default`. Those parens produce a ParenthesizedExpression node that
  // unwrapDefaultAccess() never sees through, so getDynamicImportPackageName() returns null and
  // the usage is silently dropped. This test asserts the correct/intended behavior and is
  // expected to fail until the source strips ParenthesizedExpression nodes (e.g. via
  // ts.skipParentheses) before checking for `.default`.
  it("detects usage through (await import()).default ESM interop unwrap", async () => {
    writeFile(
      "src/index.ts",
      [
        'const somepkg = (await import("somepkg")).default;',
        "somepkg.get();",
        "",
      ].join("\n"),
    );

    const result = await scanProject(PACKAGE_NAME, projectRoot);

    const getUsage = result.usages.find((u) => u.method === "somepkg.get");
    expect(getUsage).toBeDefined();
    expect(getUsage!.line).toBe(2);
  });

  it("detects usage through a namespace re-export (export * as x from pkg)", async () => {
    writeFile("src/http.ts", 'export * as http from "somepkg";\n');
    const mainPath = writeFile(
      "src/main.ts",
      ['import { http } from "./http";', 'http.get("/x");', ""].join("\n"),
    );

    const result = await scanProject(PACKAGE_NAME, projectRoot);

    const getUsage = result.usages.find((u) => u.method === "somepkg.get");
    expect(getUsage).toBeDefined();
    expect(getUsage!.line).toBe(2);
    expect(normalize(getUsage!.file)).toBe(normalize(mainPath));
  });

  it("respects extraIgnore to exclude a directory that would otherwise be scanned", async () => {
    writeFile(
      "generated/file.ts",
      [
        'import { get } from "somepkg";',
        'get("/x");',
        "",
      ].join("\n"),
    );

    const withoutIgnore = await scanProject(PACKAGE_NAME, projectRoot);
    expect(withoutIgnore.usages.some((u) => u.method === "somepkg.get")).toBe(true);

    const withIgnore = await scanProject(PACKAGE_NAME, projectRoot, ["generated"]);
    expect(withIgnore.usages.some((u) => u.method === "somepkg.get")).toBe(false);
  });

  it("reports totalFilesScanned as the count of all scanned files, not just files with usages", async () => {
    writeFile("src/a.ts", 'import { get } from "somepkg";\nget();\n');
    writeFile("src/b.ts", "export const b = 1;\n");
    writeFile("src/c.ts", "export const c = 2;\n");
    writeFile("src/d.ts", "export const d = 3;\n");
    writeFile("src/e.ts", "export const e = 4;\n");

    const result = await scanProject(PACKAGE_NAME, projectRoot);

    expect(result.totalFilesScanned).toBe(5);
    expect(result.usages.filter((u) => u.method.startsWith("somepkg"))).toHaveLength(1);
  });

  it("returns an empty usages array without throwing when the package is never used", async () => {
    writeFile("src/a.ts", "export const a = 1;\n");
    writeFile("src/b.ts", "export const b = 2;\n");

    const result = await scanProject(PACKAGE_NAME, projectRoot);

    expect(result.usages).toEqual([]);
    expect(result.totalFilesScanned).toBe(2);
  });

  it("skips files under node_modules, dist, and build even if they match the glob", async () => {
    writeFile(
      "node_modules/somepkg/index.js",
      'module.exports.get = function () {};\n',
    );
    writeFile(
      "dist/generated.js",
      ['const somepkg = require("somepkg");', "somepkg.get();", ""].join("\n"),
    );
    writeFile(
      "build/generated.js",
      ['const somepkg = require("somepkg");', "somepkg.get();", ""].join("\n"),
    );
    writeFile("src/real.ts", 'import { get } from "somepkg";\nget();\n');

    const result = await scanProject(PACKAGE_NAME, projectRoot);

    expect(result.totalFilesScanned).toBe(1);
    expect(result.usages.every((u) => normalize(u.file).includes("/src/real.ts"))).toBe(
      true,
    );
  });
});
