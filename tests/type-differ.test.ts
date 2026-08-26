import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { diffTypeDefinitions } from "../src/changelog/type-differ.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "type-differ-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Writes `content` to `<tmpDir>/<name>` and returns the full path. */
function writeFile(name: string, content: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("diffTypeDefinitions - basic removal (regression guard)", () => {
  it("flags a removed export as breaking and reports correct export totals", async () => {
    const oldFile = writeFile(
      "old.d.ts",
      `export function foo(a: string): void;\nexport function bar(): void;\n`,
    );
    const newFile = writeFile("new.d.ts", `export function bar(): void;\n`);

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    expect(result.diffStrategy).toBe("type-diff");
    expect(result.totalExportsOld).toBe(2);
    expect(result.totalExportsNew).toBe(1);
    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0]).toMatchObject({
      identifier: "pkg.foo",
      severity: "breaking",
    });
    expect(result.breakingChanges[0].description).toContain("foo was removed");
  });
});

describe("diffTypeDefinitions - function parameter change severity", () => {
  it("classifies an added OPTIONAL parameter as 'changed'", async () => {
    const oldFile = writeFile("old.d.ts", `export function f(a: string): void;\n`);
    const newFile = writeFile(
      "new.d.ts",
      `export function f(a: string, b?: number): void;\n`,
    );

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].severity).toBe("changed");
  });

  it("classifies an added REQUIRED parameter as 'breaking'", async () => {
    const oldFile = writeFile("old.d.ts", `export function f(a: string): void;\n`);
    const newFile = writeFile(
      "new.d.ts",
      `export function f(a: string, b: number): void;\n`,
    );

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].severity).toBe("breaking");
  });

  it("classifies a removed parameter as 'breaking' even when the removed parameter was optional", async () => {
    const oldFile = writeFile(
      "old.d.ts",
      `export function f(a: string, b?: number): void;\n`,
    );
    const newFile = writeFile("new.d.ts", `export function f(a: string): void;\n`);

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].severity).toBe("breaking");
  });

  it("does NOT classify an added REST parameter as breaking (rest params are never required)", async () => {
    const oldFile = writeFile("old.d.ts", `export function f(a: string): void;\n`);
    const newFile = writeFile(
      "new.d.ts",
      `export function f(a: string, ...rest: number[]): void;\n`,
    );

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].severity).toBe("changed");
  });
});

describe("diffTypeDefinitions - non-function signature changes", () => {
  it("classifies interface, type alias, and variable signature changes as 'changed', never 'breaking'", async () => {
    const oldFile = writeFile(
      "old.d.ts",
      [
        `export interface Shape { width: number; }`,
        `export type Mode = string;`,
        `export declare const flag: string;`,
      ].join("\n"),
    );
    const newFile = writeFile(
      "new.d.ts",
      [
        `export interface Shape { width: number; height: number; }`,
        `export type Mode = string | number;`,
        `export declare const flag: number;`,
      ].join("\n"),
    );

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    expect(result.breakingChanges).toHaveLength(3);
    const identifiers = result.breakingChanges.map((c) => c.identifier).sort();
    expect(identifiers).toEqual(["pkg.Mode", "pkg.Shape", "pkg.flag"]);
    for (const change of result.breakingChanges) {
      expect(change.severity).toBe("changed");
    }
  });
});

describe("diffTypeDefinitions - class member visibility", () => {
  it("excludes private and protected methods from the exported members map entirely", async () => {
    const oldFile = writeFile(
      "old.d.ts",
      [
        `export declare class C {`,
        `  private secret(): void;`,
        `  protected guarded(): void;`,
        `  public pub(): void;`,
        `}`,
      ].join("\n"),
    );
    const newFile = writeFile(
      "new.d.ts",
      [
        `export declare class C {`,
        `  private secret(x: number): void;`,
        `  protected guarded(x: number): void;`,
        `  public pub(x: number): void;`,
        `}`,
      ].join("\n"),
    );

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    // Only the public method's signature change should surface. A changed
    // private/protected signature must never produce an entry, since those
    // members aren't part of the exported map at all.
    // Note: qualifyIdentifier leaves already-dotted names (e.g. "C.pub") as-is
    // rather than prefixing them with the package name.
    const identifiers = result.breakingChanges.map((c) => c.identifier);
    expect(identifiers).toEqual(["C.pub"]);
    expect(identifiers.some((id) => id.includes("secret"))).toBe(false);
    expect(identifiers.some((id) => id.includes("guarded"))).toBe(false);
  });
});

describe("diffTypeDefinitions - additive changes", () => {
  it("produces no breaking changes when new exports are purely additive", async () => {
    const oldFile = writeFile("old.d.ts", `export function existing(): void;\n`);
    const newFile = writeFile(
      "new.d.ts",
      `export function existing(): void;\nexport function newOne(): void;\n`,
    );

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    expect(result.breakingChanges).toHaveLength(0);
    expect(result.totalExportsOld).toBe(1);
    expect(result.totalExportsNew).toBe(2);
  });
});

describe("diffTypeDefinitions - export assignment / namespace merge pattern (bug fix)", () => {
  it("recognizes 'declare namespace X {...}; export = X;' and flattens namespace members to dotted names", async () => {
    const oldFile = writeFile(
      "old.d.ts",
      [
        `declare function arg(opts: {}): string[];`,
        `declare namespace arg {`,
        `  export interface Result {`,
        `    _: string[];`,
        `  }`,
        `}`,
        `export = arg;`,
      ].join("\n"),
    );
    const newFile = writeFile(
      "new.d.ts",
      [
        `declare function arg(opts: {}): string[];`,
        `declare namespace arg {`,
        `  export interface Result {`,
        `    _: string[];`,
        `    extra: boolean;`,
        `  }`,
        `}`,
        `export = arg;`,
      ].join("\n"),
    );

    const result = await diffTypeDefinitions([oldFile], [newFile], "arg-pkg");

    // Before the fix, `export =` files produced an EMPTY exports map.
    expect(result.totalExportsOld).toBeGreaterThan(0);
    expect(result.totalExportsNew).toBeGreaterThan(0);
    expect(result.totalExportsOld).toBe(2); // "arg" function + "arg.Result" interface
    expect(result.totalExportsNew).toBe(2);

    const resultChange = result.breakingChanges.find((c) => c.identifier === "arg.Result");
    expect(resultChange).toBeDefined();
    expect(resultChange?.description).toContain("signature changed");

    // The top-level function itself is unchanged and must not appear.
    expect(result.breakingChanges.some((c) => c.identifier === "arg")).toBe(false);
    expect(result.breakingChanges.some((c) => c.identifier === "arg-pkg.arg")).toBe(false);
  });
});

describe("diffTypeDefinitions - bare re-export list pattern (bug fix)", () => {
  it("tracks members of a bare 'export { A, B };' list even without an inline export modifier", async () => {
    const oldFile = writeFile(
      "old.d.ts",
      [
        `interface Result {}`,
        `declare class AssertionError {}`,
        `export { AssertionError, Result };`,
      ].join("\n"),
    );
    const newFile = writeFile(
      "new.d.ts",
      [`interface Result {}`, `export { Result };`].join("\n"),
    );

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    // Before the fix, bare re-export members with no inline `export` modifier
    // were invisible to the differ, so this removal would go undetected.
    expect(result.totalExportsOld).toBe(2);
    expect(result.totalExportsNew).toBe(1);

    const removed = result.breakingChanges.find((c) => c.identifier === "pkg.AssertionError");
    expect(removed).toBeDefined();
    expect(removed?.description).toContain("AssertionError was removed");
    expect(removed?.severity).toBe("breaking");

    // Result's declaration is unchanged, so it must not produce a false positive.
    expect(result.breakingChanges.some((c) => c.identifier === "pkg.Result")).toBe(false);
    expect(result.breakingChanges).toHaveLength(1);
  });
});

describe("diffTypeDefinitions - inline export modifier alongside new patterns (no regression)", () => {
  it("still recognizes a plain 'export function foo()' declaration in a file that also uses a bare re-export", async () => {
    const oldFile = writeFile(
      "old.d.ts",
      [
        `export function foo(): void;`,
        `interface Extra {}`,
        `export { Extra };`,
      ].join("\n"),
    );
    const newFile = writeFile(
      "new.d.ts",
      [
        `export function foo(a: string): void;`,
        `interface Extra {}`,
        `export { Extra };`,
      ].join("\n"),
    );

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    expect(result.totalExportsOld).toBe(2);
    expect(result.totalExportsNew).toBe(2);

    const fooChange = result.breakingChanges.find((c) => c.identifier === "pkg.foo");
    expect(fooChange).toBeDefined();
    expect(fooChange?.severity).toBe("breaking");

    // Extra is unchanged and bare-exported; must not produce a false positive.
    expect(result.breakingChanges.some((c) => c.identifier === "pkg.Extra")).toBe(false);
    expect(result.breakingChanges).toHaveLength(1);
  });
});

describe("diffTypeDefinitions - interface member decomposition (bug fix)", () => {
  it("decomposes an exported interface's members into dotted names, including members inherited via extends", async () => {
    const oldFile = writeFile(
      "old.d.ts",
      [
        `export interface Base {`,
        `  get(url: string): void;`,
        `}`,
        `export interface Api extends Base {`,
        `  create(config?: string): void;`,
        `}`,
      ].join("\n"),
    );
    const newFile = writeFile(
      "new.d.ts",
      [
        `export interface Base {`,
        `  get(url: string): void;`,
        `}`,
        `export interface Api extends Base {`,
        `  create(config?: string, extra?: number): void;`,
        `}`,
      ].join("\n"),
    );

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    // "Api.create" (own member) changed; "Api.get" (inherited from Base) did not.
    const createChange = result.breakingChanges.find((c) => c.identifier === "Api.create");
    expect(createChange).toBeDefined();
    expect(createChange?.severity).toBe("changed");
    expect(result.breakingChanges.some((c) => c.identifier === "Api.get")).toBe(false);
  });

  it("flattens the common 'declare const x: Shape; export default x;' pattern onto plain package-qualified names", async () => {
    // This mirrors axios's actual .d.ts shape: a big interface describing the
    // default export's callable surface, referenced only through a `declare
    // const` + `export default`. Real usage like `pkg.create()` is recorded
    // by the scanner as "pkg.create" (package-qualified, no interface name in
    // the path) — so the differ must expose the SAME plain name, or a real
    // detected change can never match real usage.
    const oldFile = writeFile(
      "old.d.ts",
      [
        `export interface PkgInstance {`,
        `  get(url: string): void;`,
        `}`,
        `export interface PkgStatic extends PkgInstance {`,
        `  create(config?: string): PkgInstance;`,
        `}`,
        `declare const pkg: PkgStatic;`,
        `export default pkg;`,
      ].join("\n"),
    );
    const newFile = writeFile(
      "new.d.ts",
      [
        `export interface PkgInstance {`,
        `  get(url: string): void;`,
        `}`,
        `export interface PkgStatic extends PkgInstance {`,
        `  create(config?: string, extra: number): PkgInstance;`,
        `}`,
        `declare const pkg: PkgStatic;`,
        `export default pkg;`,
      ].join("\n"),
    );

    const result = await diffTypeDefinitions([oldFile], [newFile], "pkg");

    // Plain, package-qualified identifier — not "PkgStatic.create".
    const createChange = result.breakingChanges.find((c) => c.identifier === "pkg.create");
    expect(createChange).toBeDefined();
    expect(createChange?.severity).toBe("breaking"); // added a required parameter
    expect(result.breakingChanges.some((c) => c.identifier === "pkg.get")).toBe(false);
  });
});

describe("diffTypeDefinitions - multi-file input", () => {
  it("merges exports declared across multiple .d.ts files into a single map", async () => {
    const oldFileA = writeFile("old-a.d.ts", `export function foo(): void;\n`);
    const oldFileB = writeFile("old-b.d.ts", `export function bar(): void;\n`);
    const newFileA = writeFile("new-a.d.ts", `export function foo(): void;\n`);
    const newFileB = writeFile("new-b.d.ts", `export function bar(a: string): void;\n`);

    const result = await diffTypeDefinitions(
      [oldFileA, oldFileB],
      [newFileA, newFileB],
      "pkg",
    );

    expect(result.totalExportsOld).toBe(2);
    expect(result.totalExportsNew).toBe(2);
    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0]).toMatchObject({ identifier: "pkg.bar", severity: "breaking" });
  });
});
