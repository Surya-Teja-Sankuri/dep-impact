import { describe, it, expect, vi, beforeAll } from "vitest";

// `src/cli/index.ts` calls `program.parse()` at module scope (commander),
// which — given vitest's own process.argv — doesn't match any defined
// subcommand and triggers commander's help/error path, which in turn calls
// `process.exit()`. We stub both console output and process.exit before
// importing so the module can load without tearing down the test worker,
// then pull `parsePackageArg` off the loaded module.
let parsePackageArg: (input: string) => { name: string; version: string | undefined };

beforeAll(async () => {
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // Commander writes its help/usage output straight to the streams, not
  // through console.log, so it must be silenced separately.
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);

  const originalArgv = process.argv;
  process.argv = ["node", "dep-impact"];

  const mod = await import("../src/cli/index.js");
  parsePackageArg = mod.parsePackageArg;

  process.argv = originalArgv;
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

describe("parsePackageArg", () => {
  it("parses an unscoped package with no version", () => {
    expect(parsePackageArg("axios")).toStrictEqual({
      name: "axios",
      version: undefined,
    });
  });

  it("parses an unscoped package with a semver version", () => {
    expect(parsePackageArg("axios@1.0.0")).toStrictEqual({
      name: "axios",
      version: "1.0.0",
    });
  });

  it("parses an unscoped package with a dist-tag instead of semver (no validation)", () => {
    expect(parsePackageArg("axios@next")).toStrictEqual({
      name: "axios",
      version: "next",
    });
  });

  it("parses a scoped package with a version, splitting on the last @", () => {
    expect(parsePackageArg("@scope/pkg@1.0.0")).toStrictEqual({
      name: "@scope/pkg",
      version: "1.0.0",
    });
  });

  it("parses a scoped package with no version without mistaking the leading @ for a separator", () => {
    const result = parsePackageArg("@scope/pkg");
    expect(result).toStrictEqual({
      name: "@scope/pkg",
      version: undefined,
    });
    // Guard against a regression where lastIndexOf("@") finds index 0 and
    // slice(0, 0) silently produces an empty name.
    expect(result.name).toBe("@scope/pkg");
  });

  it("returns an empty string (not undefined) version for a trailing bare @", () => {
    const result = parsePackageArg("axios@");
    expect(result.name).toBe("axios");
    expect(result.version).toBe("");
    expect(Object.is(result.version, undefined)).toBe(false);
    expect(Object.is(result.version, "")).toBe(true);
  });

  it("treats a lone '@' as a name with no version, not a scope separator at index 0", () => {
    // lastIndexOf("@") === 0 here, and the guard is `atIndex > 0`, so this
    // falls through to the unscoped/no-version branch.
    expect(parsePackageArg("@")).toStrictEqual({
      name: "@",
      version: undefined,
    });
  });

  it("splits a deeply nested scoped package name on the last @ only", () => {
    expect(parsePackageArg("@my-org/sub-pkg@2.3.4-beta.1")).toStrictEqual({
      name: "@my-org/sub-pkg",
      version: "2.3.4-beta.1",
    });
  });
});
