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

  it("detects method calls on a constructed instance of a named-import class (bug fix)", async () => {
    // Before the fix, `new ImportedClass()` assigned to a local variable was
    // never tracked, so `program.name(...)` went completely undetected —
    // an extremely common pattern for any class-based library API.
    writeFile(
      "src/index.ts",
      [
        'import { Command } from "somepkg";',
        "",
        "const program = new Command();",
        'program.name("my-cli");',
        "program.parse();",
        "",
      ].join("\n"),
    );

    const result = await scanProject(PACKAGE_NAME, projectRoot);

    const nameUsage = result.usages.find((u) => u.method === "Command.name");
    expect(nameUsage).toBeDefined();
    expect(nameUsage!.line).toBe(4);

    const parseUsage = result.usages.find((u) => u.method === "Command.parse");
    expect(parseUsage).toBeDefined();
    expect(parseUsage!.line).toBe(5);
  });

  it("does not track a constructed instance of a default/namespace import as a class (unsupported, avoids guessing)", async () => {
    // Only named imports carry a known declared class name that the
    // type-differ can also resolve; a default-import alias's real exported
    // name isn't knowable from the import site alone, so it's intentionally
    // left untracked rather than guessed.
    writeFile(
      "src/index.ts",
      [
        'import Somepkg from "somepkg";',
        "",
        "const instance = new Somepkg();",
        "instance.doThing();",
        "",
      ].join("\n"),
    );

    const result = await scanProject(PACKAGE_NAME, projectRoot);

    expect(result.usages.some((u) => u.method.includes("doThing"))).toBe(false);
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

  it("does not exclude everything when scanning dep-impact's own repository directly (bug fix)", async () => {
    // The dep-impact-own-files exclusion (to avoid double-counting dep-impact's
    // own bundled copy when it's installed as a dependency elsewhere) used to
    // key off "is this file under the same root as the currently-running
    // dep-impact code" — which is trivially true for every file when you run
    // dep-impact directly against its own checkout, silently zeroing out the
    // whole scan. Vitest runs from the repo root, so process.cwd() here IS
    // dep-impact's own TOOL_ROOT — this is the exact scenario that broke.
    const result = await scanProject("some-package-that-does-not-exist", process.cwd());
    expect(result.totalFilesScanned).toBeGreaterThan(0);
  });
});
