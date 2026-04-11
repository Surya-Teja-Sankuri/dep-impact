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

    for (const breakingChange of matchingChanges) {
      risk = elevateRisk(risk, severityToRisk(breakingChange.severity));

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
  breakingChangeLookup: Map<string, BreakingChange>,
): BreakingChange[] {
  const matches: BreakingChange[] = [];
  const seenIdentifiers = new Set<string>();
  const normalizedMethod = normalizeIdentifier(method);
  const methodCandidates = buildMethodCandidates(normalizedMethod, packageName);
  const exactMatch = breakingChangeLookup.get(normalizedMethod);

  if (exactMatch) {
    matches.push(exactMatch);
    seenIdentifiers.add(normalizeIdentifier(exactMatch.identifier));
  }

  for (const breakingChange of breakingChanges) {
    const normalizedIdentifier = normalizeIdentifier(breakingChange.identifier);
    if (seenIdentifiers.has(normalizedIdentifier)) {
      continue;
    }

    const comparisonTargets = buildComparisonTargets(breakingChange, packageName);
    const isMatch = methodCandidates.some((candidate) =>
      comparisonTargets.some((target) => isCandidateMatch(candidate, target)),
    );

    if (isMatch) {
      matches.push(breakingChange);
      seenIdentifiers.add(normalizedIdentifier);
    }
  }

  return matches;
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

function buildMethodCandidates(method: string, packageName: string): string[] {
  const candidates = new Set<string>();
  const strippedMethod = stripPackagePrefix(method, packageName);

  addNonEmpty(candidates, method);
  addNonEmpty(candidates, strippedMethod);

  const methodSegments = strippedMethod.split(".");
  addNonEmpty(candidates, methodSegments[methodSegments.length - 1] ?? "");

  for (let index = 0; index < methodSegments.length; index += 1) {
    addNonEmpty(candidates, methodSegments.slice(index).join("."));
  }

  return Array.from(candidates);
}

function buildComparisonTargets(
  breakingChange: BreakingChange,
  packageName: string,
): string[] {
  const targets = new Set<string>();
  const normalizedIdentifier = normalizeIdentifier(breakingChange.identifier);
  const strippedIdentifier = stripPackagePrefix(normalizedIdentifier, packageName);

  addNonEmpty(targets, normalizedIdentifier);
  addNonEmpty(targets, strippedIdentifier);

  for (const token of extractMethodLikeTokens(breakingChange.description)) {
    addNonEmpty(targets, normalizeIdentifier(token));
  }

  return Array.from(targets);
}

function extractMethodLikeTokens(description: string): string[] {
  const matches = description.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g);
  return matches ?? [];
}

function isCandidateMatch(candidate: string, target: string): boolean {
  return (
    candidate === target ||
    target.includes(candidate) ||
    candidate.includes(target)
  );
}

function addNonEmpty(target: Set<string>, value: string): void {
  const trimmedValue = value.trim();
  if (trimmedValue.length > 0) {
    target.add(trimmedValue);
  }
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
