import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseChangelog } from "../src/changelog/parser.js";
import { fetchTypeDefinitions, cleanupTypes } from "../src/changelog/type-fetcher.js";
import { diffTypeDefinitions } from "../src/changelog/type-differ.js";

vi.mock("../src/changelog/type-fetcher.js", () => ({
  fetchTypeDefinitions: vi.fn(),
  cleanupTypes: vi.fn(),
}));

vi.mock("../src/changelog/type-differ.js", () => ({
  diffTypeDefinitions: vi.fn(),
}));

const mockedFetchTypeDefinitions = vi.mocked(fetchTypeDefinitions);
const mockedCleanupTypes = vi.mocked(cleanupTypes);
const mockedDiffTypeDefinitions = vi.mocked(diffTypeDefinitions);

function makeExtractedTypes(overrides: Partial<{
  packageName: string;
  version: string;
  dtsFiles: string[];
  tempDir: string;
  hasTypes: boolean;
}> = {}) {
  return {
    packageName: overrides.packageName ?? "some-pkg",
    version: overrides.version ?? "1.0.0",
    dtsFiles: overrides.dtsFiles ?? ["/tmp/some/index.d.ts"],
    tempDir: overrides.tempDir ?? "/tmp/some",
    hasTypes: overrides.hasTypes ?? true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseChangelog - type-diff success path", () => {
  it("returns strategy type-diff with the exact breaking changes from the differ and cleans up both type sets", async () => {
    const currentTypes = makeExtractedTypes({ version: "1.0.0", tempDir: "/tmp/current" });
    const targetTypes = makeExtractedTypes({ version: "2.0.0", tempDir: "/tmp/target" });

    mockedFetchTypeDefinitions.mockResolvedValueOnce(currentTypes);
    mockedFetchTypeDefinitions.mockResolvedValueOnce(targetTypes);

    const canned = {
      breakingChanges: [
        { identifier: "some-pkg.foo", description: "foo was removed", severity: "breaking" as const },
      ],
      totalExportsOld: 5,
      totalExportsNew: 4,
      diffStrategy: "type-diff" as const,
    };
    mockedDiffTypeDefinitions.mockResolvedValueOnce(canned);

    const result = await parseChangelog("some-pkg", "1.0.0", "2.0.0", "irrelevant changelog text", {
      silent: true,
    });

    expect(result.strategy).toBe("type-diff");
    expect(result.breakingChanges).toEqual(canned.breakingChanges);
    expect(result.versionRange).toBe("1.0.0 -> 2.0.0");

    expect(mockedCleanupTypes).toHaveBeenCalledTimes(2);
    expect(mockedCleanupTypes).toHaveBeenCalledWith(currentTypes);
    expect(mockedCleanupTypes).toHaveBeenCalledWith(targetTypes);
  });
});

describe("parseChangelog - fetch failure fallback", () => {
  it("falls back to heuristics using changelogText when fetchTypeDefinitions throws for the target version, and cleans up the successful fetch", async () => {
    const currentTypes = makeExtractedTypes({ version: "1.0.0", tempDir: "/tmp/current-ok" });

    mockedFetchTypeDefinitions.mockResolvedValueOnce(currentTypes);
    mockedFetchTypeDefinitions.mockRejectedValueOnce(new Error("network down"));

    const changelogText = "BREAKING CHANGE: something has been removed.";

    const result = await parseChangelog("some-pkg", "1.0.0", "2.0.0", changelogText, {
      silent: true,
    });

    expect(mockedDiffTypeDefinitions).not.toHaveBeenCalled();
    expect(result.strategy).toBe("regex-heuristics");
    expect(result.breakingChanges.length).toBeGreaterThan(0);

    // cleanup should be called exactly once, and NOT with undefined
    expect(mockedCleanupTypes).toHaveBeenCalledTimes(1);
    expect(mockedCleanupTypes).toHaveBeenCalledWith(currentTypes);
    for (const call of mockedCleanupTypes.mock.calls) {
      expect(call[0]).not.toBeUndefined();
    }
  });

  it("falls back to heuristics when fetchTypeDefinitions throws for the current version, and still cleans up target's fetch if it resolved first", async () => {
    // currentVersion fetch is awaited first in source, so if it throws, target fetch never runs.
    mockedFetchTypeDefinitions.mockRejectedValueOnce(new Error("registry 500"));

    const changelogText = "The API has been removed in this release.";

    const result = await parseChangelog("some-pkg", "1.0.0", "2.0.0", changelogText, {
      silent: true,
    });

    expect(mockedDiffTypeDefinitions).not.toHaveBeenCalled();
    expect(result.strategy).toBe("regex-heuristics");
    // Only one fetch call was made (current), and it threw, so cleanup should never be
    // called with undefined; since currentTypes stays null, cleanupTypes should not run at all.
    expect(mockedCleanupTypes).not.toHaveBeenCalled();
  });
});

describe("parseChangelog - hasTypes:false skips diffing", () => {
  it("skips diffTypeDefinitions entirely when either version reports hasTypes:false and falls through to heuristics", async () => {
    const currentTypes = makeExtractedTypes({ hasTypes: true, tempDir: "/tmp/c" });
    const targetTypes = makeExtractedTypes({ hasTypes: false, dtsFiles: [], tempDir: "/tmp/t" });

    mockedFetchTypeDefinitions.mockResolvedValueOnce(currentTypes);
    mockedFetchTypeDefinitions.mockResolvedValueOnce(targetTypes);

    const changelogText = "Some method was renamed to newMethod.";

    const result = await parseChangelog("some-pkg", "1.0.0", "2.0.0", changelogText, {
      silent: true,
    });

    expect(mockedDiffTypeDefinitions).not.toHaveBeenCalled();
    expect(result.strategy).toBe("regex-heuristics");

    expect(mockedCleanupTypes).toHaveBeenCalledTimes(2);
    expect(mockedCleanupTypes).toHaveBeenCalledWith(currentTypes);
    expect(mockedCleanupTypes).toHaveBeenCalledWith(targetTypes);
  });

  it("falls through to 'none' strategy when types are unavailable and changelogText is empty", async () => {
    mockedFetchTypeDefinitions.mockResolvedValueOnce(makeExtractedTypes({ hasTypes: false, dtsFiles: [] }));
    mockedFetchTypeDefinitions.mockResolvedValueOnce(makeExtractedTypes({ hasTypes: false, dtsFiles: [] }));

    const result = await parseChangelog("some-pkg", "1.0.0", "2.0.0", "", { silent: true });

    expect(mockedDiffTypeDefinitions).not.toHaveBeenCalled();
    expect(result.strategy).toBe("none");
    expect(result.breakingChanges).toEqual([]);
  });
});

describe("parseChangelog - heuristics-only path (no types available)", () => {
  beforeEach(() => {
    mockedFetchTypeDefinitions.mockResolvedValue(makeExtractedTypes({ hasTypes: false, dtsFiles: [] }));
  });

  it("returns strategy 'none' with no breaking changes for empty changelog text", async () => {
    const result = await parseChangelog("pkg", "1.0.0", "2.0.0", "", { silent: true });
    expect(result.strategy).toBe("none");
    expect(result.breakingChanges).toEqual([]);
  });

  it("returns strategy 'none' with no breaking changes for whitespace-only changelog text", async () => {
    const result = await parseChangelog("pkg", "1.0.0", "2.0.0", "   \n\t \n  ", { silent: true });
    expect(result.strategy).toBe("none");
    expect(result.breakingChanges).toEqual([]);
  });

  it("classifies a line containing 'has been removed' as severity breaking", async () => {
    const result = await parseChangelog(
      "pkg",
      "1.0.0",
      "2.0.0",
      "The oldThing has been removed from the package.",
      { silent: true },
    );
    expect(result.strategy).toBe("regex-heuristics");
    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].severity).toBe("breaking");
  });

  it("classifies a line containing 'renamed' (and no breaking signal) as severity changed", async () => {
    const result = await parseChangelog(
      "pkg",
      "1.0.0",
      "2.0.0",
      "oldMethodName renamed to newMethodName.",
      { silent: true },
    );
    expect(result.strategy).toBe("regex-heuristics");
    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].severity).toBe("changed");
  });

  it("resolves to 'breaking' when a line contains both a changed signal ('deprecated') and a breaking signal ('no longer')", async () => {
    const result = await parseChangelog(
      "pkg",
      "1.0.0",
      "2.0.0",
      "legacyFn is deprecated and no longer supported.",
      { silent: true },
    );
    expect(result.strategy).toBe("regex-heuristics");
    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].severity).toBe("breaking");
  });

  it("produces no breaking change for a line with neither a breaking nor changed signal", async () => {
    const result = await parseChangelog(
      "pkg",
      "1.0.0",
      "2.0.0",
      "This release improves performance across the board.",
      { silent: true },
    );
    expect(result.strategy).toBe("none");
    expect(result.breakingChanges).toEqual([]);
  });
});

describe("parseChangelog - identifier extraction regressions", () => {
  beforeEach(() => {
    mockedFetchTypeDefinitions.mockResolvedValue(makeExtractedTypes({ hasTypes: false, dtsFiles: [] }));
  });

  it("extracts PascalCase identifier 'CancelToken', not stopwords like 'is' or 'in' or 'of'", async () => {
    const result = await parseChangelog(
      "pkg",
      "1.0.0",
      "2.0.0",
      "BREAKING CHANGE: CancelToken is removed in favor of AbortController.",
      { silent: true },
    );
    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].identifier).toBe("CancelToken");
    expect(result.breakingChanges[0].identifier).not.toBe("is");
    expect(result.breakingChanges[0].identifier).not.toBe("in");
    expect(result.breakingChanges[0].identifier).not.toBe("of");
  });

  it("extracts a dotted identifier like 'axios.get'", async () => {
    const result = await parseChangelog(
      "pkg",
      "1.0.0",
      "2.0.0",
      "axios.get removed",
      { silent: true },
    );
    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].identifier).toBe("axios.get");
  });

  it("produces no breaking change when a signal word has no real identifier nearby (only stopwords)", async () => {
    // "removed" is itself a stopword and also a signal; "the" and "for" are stopwords too.
    const result = await parseChangelog(
      "pkg",
      "1.0.0",
      "2.0.0",
      "This has been removed for the API.",
      { silent: true },
    );
    expect(result.breakingChanges).toEqual([]);
    expect(result.strategy).toBe("none");
  });
});

describe("parseChangelog - duplicate identifier dedup", () => {
  beforeEach(() => {
    mockedFetchTypeDefinitions.mockResolvedValue(makeExtractedTypes({ hasTypes: false, dtsFiles: [] }));
  });

  it("keeps only the first occurrence's description and severity when two lines flag the same identifier", async () => {
    const changelogText = [
      "SomeUtil has been removed from the public API.",
      "SomeUtil renamed to SomeUtilV2 in a later patch.",
    ].join("\n");

    const result = await parseChangelog("pkg", "1.0.0", "2.0.0", changelogText, {
      silent: true,
    });

    const matches = result.breakingChanges.filter((bc) => bc.identifier === "SomeUtil");
    expect(matches).toHaveLength(1);
    expect(matches[0].severity).toBe("breaking");
    expect(matches[0].description).toBe("SomeUtil has been removed from the public API.");
  });
});
