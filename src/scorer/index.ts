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

export type MethodOverrides = Record<string, "safe" | "breaking" | "changed">;

/**
 * Scores upgrade risk by cross-referencing per-file package usage against the
 * parsed breaking changes for the target version range. `overrides` (from
 * .depimpact.json) lets a user force a specific method's classification,
 * taking precedence over any detected breaking change for that method.
 */
export function scoreRisk(
  usageMap: UsageMap,
  parsed: ParsedChangelog,
  currentVersion: string,
  targetVersion: string,
  overrides: MethodOverrides = {},
  totalFilesScanned?: number,
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
    scoreFile(
      file,
      methods,
      usageMap.packageName,
      parsed.breakingChanges,
      breakingChangeLookup,
      overrides,
    ),
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
    totalFilesScanned: totalFilesScanned ?? usagesByFile.size,
    strategy: parsed.strategy,
  };
}

function scoreFile(
  file: string,
  methods: string[],
  packageName: string,
  breakingChanges: BreakingChange[],
  breakingChangeLookup: Map<string, BreakingChange>,
  overrides: MethodOverrides,
): FileRisk {
  let risk: RiskLevel = "NONE";
  const reasons: string[] = [];
  const affectedMethods: string[] = [];
  const seenReasons = new Set<string>();
  const seenAffectedMethods = new Set<string>();

  for (const method of methods) {
    const overrideSeverity = getOverrideSeverity(method, packageName, overrides);
    if (overrideSeverity) {
      const effectiveRisk = overrideSeverityToRisk(overrideSeverity);
      risk = elevateRisk(risk, effectiveRisk);

      if (effectiveRisk !== "NONE") {
        const trimmedReason = truncateReason(`${method}: manually marked ${overrideSeverity}`);
        if (!seenReasons.has(trimmedReason)) {
          seenReasons.add(trimmedReason);
          reasons.push(trimmedReason);
        }

        if (!seenAffectedMethods.has(method)) {
          seenAffectedMethods.add(method);
          affectedMethods.push(method);
        }
      }

      continue;
    }

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

/**
 * Looks up a user override for a method, matching with or without the
 * package name prefix so both "axios.get" and "get" work as override keys.
 */
function getOverrideSeverity(
  method: string,
  packageName: string,
  overrides: MethodOverrides,
): "safe" | "breaking" | "changed" | null {
  const normalizedMethod = normalizeIdentifier(method);
  const strippedMethod = stripPackagePrefix(normalizedMethod, packageName);

  for (const [key, value] of Object.entries(overrides)) {
    const normalizedKey = normalizeIdentifier(key);
    const strippedKey = stripPackagePrefix(normalizedKey, packageName);

    if (normalizedMethod === normalizedKey || strippedMethod === strippedKey) {
      return value;
    }
  }

  return null;
}

function overrideSeverityToRisk(severity: "safe" | "breaking" | "changed"): RiskLevel {
  if (severity === "breaking") {
    return "HIGH";
  }

  if (severity === "changed") {
    return "MEDIUM";
  }

  return "NONE";
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

/**
 * Extracts tokens from a breaking-change description that look like real
 * code references. Dotted chains (e.g. "axios.interceptors") are trusted
 * anywhere in the text. Bare single-word tokens are only trusted inside
 * backtick code spans (e.g. "the `post` method was removed") — otherwise
 * ordinary prose words would collide with real (often short) method names
 * like "get", "post", or "close".
 */
function extractMethodLikeTokens(description: string): string[] {
  const tokens: string[] = [];

  const dottedMatches = description.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g);
  if (dottedMatches) {
    tokens.push(...dottedMatches);
  }

  const codeSpans = description.match(/`[^`]+`/g) ?? [];
  for (const span of codeSpans) {
    const wordMatches = span.slice(1, -1).match(/[A-Za-z_$][\w$]*/g);
    if (wordMatches) {
      tokens.push(...wordMatches);
    }
  }

  return tokens;
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
