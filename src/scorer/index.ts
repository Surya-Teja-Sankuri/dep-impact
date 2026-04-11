import type { ParsedChangelog, BreakingChange } from "../changelog/parser.js";
import type { UsageMap } from "../scanner/index.js";

export type RiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export type FileRisk = {
  file: string;
  risk: RiskLevel;
  reasons: string[];
  affectedMethods: string[];
};

export type ScoreResult = {
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  overall: RiskLevel;
  files: FileRisk[];
  totalFilesAffected: number;
  totalFilesScanned: number;
  strategy: "type-diff" | "regex-heuristics" | "none";
};

type BreakingChangeMatch = {
  breakingChange: BreakingChange;
  capSeverity: boolean; // true when matched via Strategy 4 (description token only)
};

/**
 * Scores upgrade risk by cross-referencing per-file package usage against the
 * parsed breaking changes for the target version range.
 */
export function scoreRisk(
  usageMap: UsageMap,
  parsed: ParsedChangelog,
  currentVersion: string,
  targetVersion: string,
): ScoreResult {
  const breakingChangeLookup = new Map<string, BreakingChange>();
  for (const breakingChange of parsed.breakingChanges) {
    const normalizedIdentifier = normalizeIdentifier(breakingChange.identifier);
    if (!breakingChangeLookup.has(normalizedIdentifier)) {
      breakingChangeLookup.set(normalizedIdentifier, breakingChange);
    }
  }

  const usagesByFile = new Map<string, string[]>();
  for (const usage of usageMap.usages) {
    const existingMethods = usagesByFile.get(usage.file) ?? [];
    existingMethods.push(usage.method);
    usagesByFile.set(usage.file, existingMethods);
  }

  const files = Array.from(usagesByFile.entries()).map(([file, methods]) =>
    scoreFile(file, methods, usageMap.packageName, parsed.breakingChanges, breakingChangeLookup),
  );

  const overall = getOverallRisk(files);
  const totalFilesAffected = files.filter((fileRisk) => fileRisk.risk !== "NONE").length;

  return {
    packageName: usageMap.packageName,
    currentVersion,
    targetVersion,
    overall,
    files,
    totalFilesAffected,
    totalFilesScanned: usagesByFile.size,
    strategy: parsed.strategy,
  };
}

function scoreFile(
  file: string,
  methods: string[],
  packageName: string,
  breakingChanges: BreakingChange[],
  breakingChangeLookup: Map<string, BreakingChange>,
): FileRisk {
  let risk: RiskLevel = "NONE";
  const reasons: string[] = [];
  const affectedMethods: string[] = [];
  const seenReasons = new Set<string>();
  const seenAffectedMethods = new Set<string>();

  for (const method of methods) {
    const matchingChanges = findMatchingBreakingChanges(
      method,
      packageName,
      breakingChanges,
      breakingChangeLookup,
    );

    for (const { breakingChange, capSeverity } of matchingChanges) {
      let effectiveRisk = severityToRisk(breakingChange.severity);
      // Strategy 4 matches are weak — cap HIGH → MEDIUM (breaking → changed)
      if (capSeverity && effectiveRisk === "HIGH") {
        effectiveRisk = "MEDIUM";
      }
      risk = elevateRisk(risk, effectiveRisk);

      const trimmedReason = truncateReason(breakingChange.description.trim());
      if (!seenReasons.has(trimmedReason)) {
        seenReasons.add(trimmedReason);
        reasons.push(trimmedReason);
      }

      if (!seenAffectedMethods.has(method)) {
        seenAffectedMethods.add(method);
        affectedMethods.push(method);
      }
    }
  }

  return {
    file,
    risk,
    reasons,
    affectedMethods,
  };
}

function findMatchingBreakingChanges(
  method: string,
  packageName: string,
  breakingChanges: BreakingChange[],
  _breakingChangeLookup: Map<string, BreakingChange>,
): BreakingChangeMatch[] {
  const matches: BreakingChangeMatch[] = [];
  const seenIdentifiers = new Set<string>();
  const normalizedMethod = normalizeIdentifier(method);

  for (const breakingChange of breakingChanges) {
    const normalizedIdentifier = normalizeIdentifier(breakingChange.identifier);
    if (seenIdentifiers.has(normalizedIdentifier)) {
      continue;
    }

    const result = matchMethodToBreakingChange(
      normalizedMethod,
      packageName,
      normalizedIdentifier,
      breakingChange.description,
    );

    if (result.matched) {
      matches.push({ breakingChange, capSeverity: result.capSeverity });
      seenIdentifiers.add(normalizedIdentifier);
    }
  }

  return matches;
}

/**
 * Tests whether a usage method matches a breaking change using five strategies
 * in priority order, stopping at the first match.
 *
 * Strategy 1 — Exact:   method === identifier (with or without package prefix)
 * Strategy 2 — Parent:  identifier is an ancestor of method (usage is more specific)
 * Strategy 3 — Child:   method is an ancestor of identifier (breaking change is more specific)
 * Strategy 4 — Description: stripped method name appears as a token in the description
 *              (weak match — caller should cap severity at MEDIUM)
 * Strategy 5 — No match
 */
function matchMethodToBreakingChange(
  normalizedMethod: string,
  packageName: string,
  normalizedIdentifier: string,
  description: string,
): { matched: boolean; capSeverity: boolean } {
  const strippedMethod = stripPackagePrefix(normalizedMethod, packageName);
  const strippedIdentifier = stripPackagePrefix(normalizedIdentifier, packageName);

  // Strategy 1: Exact match (handles identifiers with or without package prefix)
  if (
    normalizedMethod === normalizedIdentifier ||
    (strippedMethod && strippedIdentifier && strippedMethod === strippedIdentifier)
  ) {
    return { matched: true, capSeverity: false };
  }

  // Strategy 2: Parent match — breaking change is an ancestor of the usage
  // e.g. usage "axios.defaults.headers", BC "axios.defaults" → match
  if (
    normalizedMethod.startsWith(`${normalizedIdentifier}.`) ||
    (strippedIdentifier && strippedMethod.startsWith(`${strippedIdentifier}.`))
  ) {
    return { matched: true, capSeverity: false };
  }

  // Strategy 3: Child match — usage is an ancestor of the breaking change
  // e.g. usage "axios.create", BC "axios.create.config" → match
  if (
    normalizedIdentifier.startsWith(`${normalizedMethod}.`) ||
    (strippedMethod && strippedIdentifier.startsWith(`${strippedMethod}.`))
  ) {
    return { matched: true, capSeverity: false };
  }

  // Strategy 4: Description token match (weak — cap severity at MEDIUM)
  // Strip package prefix then check if the method name appears as a token
  // in the breaking change description.
  if (strippedMethod) {
    const descriptionTokens = extractMethodLikeTokens(description).map(normalizeIdentifier);
    if (descriptionTokens.includes(strippedMethod)) {
      return { matched: true, capSeverity: true };
    }
  }

  // Strategy 5: No match
  return { matched: false, capSeverity: false };
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

function stripPackagePrefix(identifier: string, packageName: string): string {
  const normalizedPackageName = normalizeIdentifier(packageName);
  const prefix = `${normalizedPackageName}.`;

  if (identifier.startsWith(prefix)) {
    return identifier.slice(prefix.length);
  }

  return identifier;
}

function extractMethodLikeTokens(description: string): string[] {
  const matches = description.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g);
  return matches ?? [];
}

function severityToRisk(
  severity: BreakingChange["severity"],
): RiskLevel {
  if (severity === "breaking") {
    return "HIGH";
  }

  if (severity === "changed") {
    return "MEDIUM";
  }

  if (severity === "deprecated") {
    return "LOW";
  }

  return "NONE";
}

function elevateRisk(current: RiskLevel, next: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ["NONE", "LOW", "MEDIUM", "HIGH"];
  return order.indexOf(next) > order.indexOf(current) ? next : current;
}

function truncateReason(reason: string): string {
  return reason.length <= 120 ? reason : `${reason.slice(0, 117)}...`;
}

function getOverallRisk(files: FileRisk[]): RiskLevel {
  if (files.some((fileRisk) => fileRisk.risk === "HIGH")) {
    return "HIGH";
  }

  if (files.some((fileRisk) => fileRisk.risk === "MEDIUM")) {
    return "MEDIUM";
  }

  if (files.some((fileRisk) => fileRisk.risk === "LOW")) {
    return "LOW";
  }

  return "NONE";
}
