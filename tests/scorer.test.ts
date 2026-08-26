import { describe, it, expect } from "vitest";
import { scoreRisk } from "../src/scorer/index.js";
import type { UsageMap, Usage } from "../src/scanner/index.js";
import type { ParsedChangelog, BreakingChange } from "../src/changelog/parser.js";

const PACKAGE_NAME = "axios";
const CURRENT_VERSION = "0.27.0";
const TARGET_VERSION = "1.0.0";

function usage(method: string, file: string, line = 1): Usage {
  return { method, file, line };
}

function usageMap(usages: Usage[]): UsageMap {
  return {
    packageName: PACKAGE_NAME,
    usages,
    totalFilesScanned: usages.length,
  };
}

function breakingChange(
  identifier: string,
  description: string,
  severity: BreakingChange["severity"] = "breaking",
): BreakingChange {
  return { identifier, description, severity };
}

function parsed(
  breakingChanges: BreakingChange[],
  strategy: ParsedChangelog["strategy"] = "type-diff",
): ParsedChangelog {
  return { breakingChanges, versionRange: `${CURRENT_VERSION} -> ${TARGET_VERSION}`, strategy };
}

function score(
  map: UsageMap,
  parsedChangelog: ParsedChangelog,
  overrides: Record<string, "safe" | "breaking" | "changed"> = {},
  totalFilesScanned?: number,
) {
  return scoreRisk(map, parsedChangelog, CURRENT_VERSION, TARGET_VERSION, overrides, totalFilesScanned);
}

describe("scoreRisk", () => {
  describe("empty usage map", () => {
    it("returns overall NONE with no files and zero counts when there are no usages", () => {
      const result = score(usageMap([]), parsed([]));

      expect(result.overall).toBe("NONE");
      expect(result.files).toEqual([]);
      expect(result.totalFilesAffected).toBe(0);
      expect(result.totalFilesScanned).toBe(0);
    });

    it("falls back to the number of distinct files with usages when totalFilesScanned is omitted", () => {
      const map = usageMap([usage("axios.get", "a.ts"), usage("axios.post", "b.ts")]);
      const result = score(map, parsed([]));

      expect(result.totalFilesScanned).toBe(2);
    });

    it("honors an explicitly passed totalFilesScanned even when it differs from the usage file count", () => {
      const map = usageMap([usage("axios.get", "a.ts")]);
      const result = score(map, parsed([]), {}, 42);

      expect(result.totalFilesScanned).toBe(42);
    });

    it("honors totalFilesScanned of 0 even with usages present, verbatim", () => {
      const map = usageMap([usage("axios.get", "a.ts")]);
      const result = score(map, parsed([]), {}, 0);

      expect(result.totalFilesScanned).toBe(0);
    });
  });

  describe("exact-match strategy", () => {
    it("scores HIGH for a breaking severity match, case-insensitively, with package prefix on both sides", () => {
      const map = usageMap([usage("axios.GET", "a.ts")]);
      const result = score(
        map,
        parsed([breakingChange("Axios.get", "the get shorthand signature changed", "breaking")]),
      );

      expect(result.files[0].risk).toBe("HIGH");
      expect(result.overall).toBe("HIGH");
    });

    it("scores MEDIUM for a changed severity exact match", () => {
      const map = usageMap([usage("axios.post", "a.ts")]);
      const result = score(
        map,
        parsed([breakingChange("axios.post", "post now returns a different shape", "changed")]),
      );

      expect(result.files[0].risk).toBe("MEDIUM");
    });

    it("scores LOW for a deprecated severity exact match", () => {
      const map = usageMap([usage("axios.all", "a.ts")]);
      const result = score(
        map,
        parsed([breakingChange("axios.all", "axios.all is deprecated", "deprecated")]),
      );

      expect(result.files[0].risk).toBe("LOW");
    });

    it("matches an identifier without the package-name prefix against a prefixed usage method", () => {
      const map = usageMap([usage("axios.get", "a.ts")]);
      const result = score(map, parsed([breakingChange("get", "get behavior changed", "changed")]));

      expect(result.files[0].risk).toBe("MEDIUM");
      expect(result.files[0].affectedMethods).toEqual(["axios.get"]);
    });
  });

  describe("ancestor matching (parent/child) and near-miss rejection", () => {
    it("matches when the breaking-change identifier is an ancestor of a more specific usage (parent match)", () => {
      const map = usageMap([usage("axios.defaults.headers.common", "a.ts")]);
      const result = score(
        map,
        parsed([breakingChange("axios.defaults", "defaults object structure changed", "breaking")]),
      );

      expect(result.files[0].risk).toBe("HIGH");
    });

    it("matches when the usage is an ancestor of a more specific breaking-change identifier (child match)", () => {
      const map = usageMap([usage("axios.create", "a.ts")]);
      const result = score(
        map,
        parsed([breakingChange("axios.create.config", "create config option removed", "breaking")]),
      );

      expect(result.files[0].risk).toBe("HIGH");
    });

    it("does not match a near-miss where one identifier is merely a string-prefix of the other without a dot boundary", () => {
      const map = usageMap([usage("axios.post", "a.ts")]);
      const result = score(
        map,
        parsed([breakingChange("axios.postForm", "postForm helper removed entirely", "breaking")]),
      );

      expect(result.files[0].risk).toBe("NONE");
      expect(result.files[0].affectedMethods).toEqual([]);
    });
  });

  describe("Strategy 4: description backtick-token match", () => {
    it("matches a usage via a backtick-quoted code span in the description and caps breaking severity to MEDIUM", () => {
      const map = usageMap([usage("axios.interceptors", "a.ts")]);
      const result = score(
        map,
        parsed([
          breakingChange(
            "axios.unrelatedThing",
            "the `interceptors` option was removed",
            "breaking",
          ),
        ]),
      );

      expect(result.files[0].risk).toBe("MEDIUM");
      expect(result.files[0].affectedMethods).toEqual(["axios.interceptors"]);
    });

    it("leaves an already-MEDIUM (changed) severity at MEDIUM when matched only via a backtick token", () => {
      const map = usageMap([usage("axios.interceptors", "a.ts")]);
      const result = score(
        map,
        parsed([
          breakingChange(
            "axios.unrelatedThing",
            "the `interceptors` option was changed",
            "changed",
          ),
        ]),
      );

      expect(result.files[0].risk).toBe("MEDIUM");
    });

    it("does NOT match on a plain prose word that merely coincides with a usage's method name (regression test)", () => {
      const map = usageMap([usage("axios.post", "a.ts")]);
      const result = score(
        map,
        parsed([
          breakingChange(
            "axios.unrelatedThing",
            "please post updates on GitHub",
            "breaking",
          ),
        ]),
      );

      expect(result.files[0].risk).toBe("NONE");
      expect(result.files[0].reasons).toEqual([]);
      expect(result.files[0].affectedMethods).toEqual([]);
    });
  });

  describe("overrides", () => {
    it("forces NONE for a method overridden as safe, contributing no reason or affected-method entry", () => {
      const map = usageMap([usage("axios.get", "a.ts")]);
      const result = score(
        map,
        parsed([breakingChange("axios.get", "get was removed", "breaking")]),
        { get: "safe" },
      );

      expect(result.files[0].risk).toBe("NONE");
      expect(result.files[0].reasons).toEqual([]);
      expect(result.files[0].affectedMethods).toEqual([]);
    });

    it("forces HIGH for a method overridden as breaking even with no matching breaking change", () => {
      const map = usageMap([usage("axios.get", "a.ts")]);
      const result = score(map, parsed([]), { "axios.get": "breaking" });

      expect(result.files[0].risk).toBe("HIGH");
      expect(result.files[0].affectedMethods).toEqual(["axios.get"]);
      expect(result.files[0].reasons[0]).toContain("manually marked breaking");
    });

    it("forces MEDIUM for a method overridden as changed", () => {
      const map = usageMap([usage("axios.get", "a.ts")]);
      const result = score(map, parsed([]), { "axios.get": "changed" });

      expect(result.files[0].risk).toBe("MEDIUM");
    });

    it("matches an override key without the package prefix against a prefixed usage method", () => {
      const map = usageMap([usage("axios.get", "a.ts")]);
      const result = score(map, parsed([]), { get: "breaking" });

      expect(result.files[0].risk).toBe("HIGH");
      expect(result.files[0].affectedMethods).toEqual(["axios.get"]);
    });
  });

  describe("deduplication and reason truncation", () => {
    it("produces only one reason and one affectedMethods entry for two identical usage entries matching the same breaking change", () => {
      const map = usageMap([
        usage("axios.get", "a.ts", 5),
        usage("axios.get", "a.ts", 12),
      ]);
      const result = score(
        map,
        parsed([breakingChange("axios.get", "get was removed", "breaking")]),
      );

      expect(result.files[0].reasons).toHaveLength(1);
      expect(result.files[0].affectedMethods).toHaveLength(1);
      expect(result.files[0].affectedMethods).toEqual(["axios.get"]);
    });

    it("truncates a description longer than 120 characters to 117 chars plus an ellipsis", () => {
      const longDescription = "x".repeat(150);
      const map = usageMap([usage("axios.get", "a.ts")]);
      const result = score(
        map,
        parsed([breakingChange("axios.get", longDescription, "breaking")]),
      );

      expect(result.files[0].reasons[0]).toHaveLength(120);
      expect(result.files[0].reasons[0]).toBe(`${"x".repeat(117)}...`);
    });

    it("does not truncate a description of exactly 120 characters", () => {
      const exactDescription = "y".repeat(120);
      const map = usageMap([usage("axios.get", "a.ts")]);
      const result = score(
        map,
        parsed([breakingChange("axios.get", exactDescription, "breaking")]),
      );

      expect(result.files[0].reasons[0]).toBe(exactDescription);
    });
  });

  describe("overall risk aggregation", () => {
    it("takes the max risk across files, counting only non-NONE files as affected", () => {
      const map = usageMap([
        usage("axios.all", "low.ts"),
        usage("axios.unmatched", "none.ts"),
        usage("axios.get", "high.ts"),
      ]);
      const result = score(
        map,
        parsed([
          breakingChange("axios.all", "axios.all is deprecated", "deprecated"),
          breakingChange("axios.get", "get was removed", "breaking"),
        ]),
      );

      const riskByFile = Object.fromEntries(result.files.map((f) => [f.file, f.risk]));
      expect(riskByFile["low.ts"]).toBe("LOW");
      expect(riskByFile["none.ts"]).toBe("NONE");
      expect(riskByFile["high.ts"]).toBe("HIGH");

      expect(result.overall).toBe("HIGH");
      expect(result.totalFilesAffected).toBe(2);
      expect(result.files).toHaveLength(3);
    });
  });

  describe("result metadata", () => {
    it("passes through packageName, currentVersion, targetVersion, and strategy unchanged", () => {
      const map = usageMap([usage("axios.get", "a.ts")]);
      const result = score(map, parsed([], "regex-heuristics"));

      expect(result.packageName).toBe(PACKAGE_NAME);
      expect(result.currentVersion).toBe(CURRENT_VERSION);
      expect(result.targetVersion).toBe(TARGET_VERSION);
      expect(result.strategy).toBe("regex-heuristics");
    });
  });
});
