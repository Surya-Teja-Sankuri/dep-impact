import { cleanupTypes, fetchTypeDefinitions } from "./type-fetcher.js";
import { diffTypeDefinitions, type BreakingChange } from "./type-differ.js";

export type { BreakingChange } from "./type-differ.js";

export type ParsedChangelog = {
  breakingChanges: BreakingChange[];
  versionRange: string;
  strategy: "type-diff" | "regex-heuristics" | "none";
};

const BREAKING_SIGNALS = [
  "breaking change",
  "removed",
  "no longer",
  "has been removed",
  "is removed",
  "breaking:",
];

const CHANGED_SIGNALS = [
  "changed",
  "renamed",
  "updated",
  "modified",
  "now returns",
  "signature",
  "deprecated",
];

const METHOD_LIKE_PATTERN = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|[a-z][A-Za-z0-9_$]+/g;

/**
 * Parses package upgrade impact by preferring declaration-file diffs and
 * falling back to changelog heuristics when types are unavailable.
 */
export async function parseChangelog(
  packageName: string,
  currentVersion: string,
  targetVersion: string,
  changelogText: string,
): Promise<ParsedChangelog> {
  const versionRange = `${currentVersion} -> ${targetVersion}`;
  let currentTypes:
    | Awaited<ReturnType<typeof fetchTypeDefinitions>>
    | null = null;
  let targetTypes:
    | Awaited<ReturnType<typeof fetchTypeDefinitions>>
    | null = null;

  try {
    currentTypes = await fetchTypeDefinitions(packageName, currentVersion);
    targetTypes = await fetchTypeDefinitions(packageName, targetVersion);

    if (currentTypes.hasTypes && targetTypes.hasTypes) {
      const diffResult = await diffTypeDefinitions(
        currentTypes.dtsFiles,
        targetTypes.dtsFiles,
        packageName,
      );

      console.log("Using type definitions for accurate diffing");
      return {
        breakingChanges: diffResult.breakingChanges,
        versionRange,
        strategy: "type-diff",
      };
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.log(`Type definition diff failed: ${error.message}`);
    } else {
      console.log("Type definition diff failed");
    }
  } finally {
    if (currentTypes) {
      await cleanupTypes(currentTypes);
    }

    if (targetTypes) {
      await cleanupTypes(targetTypes);
    }
  }

  const heuristicResult = parseWithHeuristics(changelogText, versionRange);
  if (heuristicResult) {
    console.log("Falling back to changelog text heuristics");
    return heuristicResult;
  }

  console.log("No type definitions or changelog available");
  return {
    breakingChanges: [],
    versionRange,
    strategy: "none",
  };
}

function parseWithHeuristics(
  changelogText: string,
  versionRange: string,
): ParsedChangelog | null {
  if (changelogText.trim() === "") {
    return null;
  }

  const changesByIdentifier = new Map<string, BreakingChange>();
  const lines = changelogText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const severity = getSeverityForLine(line.toLowerCase());
    if (!severity) {
      continue;
    }

    const identifier = extractNearestIdentifier(line);
    if (!identifier || changesByIdentifier.has(identifier)) {
      continue;
    }

    changesByIdentifier.set(identifier, {
      identifier,
      description: line,
      severity,
    });
  }

  if (changesByIdentifier.size === 0) {
    return null;
  }

  return {
    breakingChanges: Array.from(changesByIdentifier.values()),
    versionRange,
    strategy: "regex-heuristics",
  };
}

function getSeverityForLine(
  lowerLine: string,
): "breaking" | "changed" | null {
  if (BREAKING_SIGNALS.some((signal) => lowerLine.includes(signal))) {
    return "breaking";
  }

  if (CHANGED_SIGNALS.some((signal) => lowerLine.includes(signal))) {
    return "changed";
  }

  return null;
}

function extractNearestIdentifier(line: string): string | null {
  const matches = Array.from(line.matchAll(METHOD_LIKE_PATTERN));
  if (matches.length === 0) {
    return null;
  }

  const signalIndex = findSignalIndex(line.toLowerCase());
  if (signalIndex === -1) {
    return null;
  }

  let nearestIdentifier: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const match of matches) {
    const index = match.index ?? 0;
    const distance = Math.abs(index - signalIndex);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIdentifier = match[0];
    }
  }

  return nearestIdentifier;
}

function findSignalIndex(lowerLine: string): number {
  const indices = [...BREAKING_SIGNALS, ...CHANGED_SIGNALS]
    .map((signal) => lowerLine.indexOf(signal))
    .filter((index) => index >= 0);

  if (indices.length === 0) {
    return -1;
  }

  return Math.min(...indices);
}
