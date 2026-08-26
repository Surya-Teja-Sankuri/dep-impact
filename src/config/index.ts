import fs from "node:fs";
import path from "node:path";

export type DepImpactConfig = {
  ignore: string[];
  overrides: Record<string, "safe" | "breaking" | "changed">;
  github: {
    token: string | null;
  };
  output: {
    json: boolean;
    verbose: boolean;
  };
};

const DEFAULT_IGNORE = ["node_modules", "dist", "build", ".git", "coverage"];

function getDefaultConfig(): DepImpactConfig {
  return {
    ignore: [...DEFAULT_IGNORE],
    overrides: {},
    github: {
      token: process.env.GITHUB_TOKEN ?? null,
    },
    output: {
      json: false,
      verbose: false,
    },
  };
}

type RawConfig = {
  ignore?: unknown;
  overrides?: unknown;
  github?: unknown;
  output?: unknown;
};

/**
 * Loads configuration from an optional .depimpact.json file in the project
 * root and merges it with sensible defaults. All fields are optional — the
 * tool works with zero configuration.
 */
export function loadConfig(projectRoot: string): DepImpactConfig {
  const defaults = getDefaultConfig();
  const configPath = path.join(projectRoot, ".depimpact.json");

  if (!fs.existsSync(configPath)) {
    return defaults;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read .depimpact.json: ${message}`);
  }

  let parsed: RawConfig;
  try {
    parsed = JSON.parse(raw) as RawConfig;
  } catch {
    throw new Error("Invalid .depimpact.json — must be valid JSON");
  }

  if (parsed.ignore !== undefined && !Array.isArray(parsed.ignore)) {
    throw new Error(".depimpact.json ignore field must be an array");
  }

  if (
    parsed.ignore !== undefined &&
    !(parsed.ignore as unknown[]).every((entry) => typeof entry === "string")
  ) {
    throw new Error(".depimpact.json ignore field must be an array of strings");
  }

  // Merge ignore: combine defaults and user values, deduplicate
  const mergedIgnore =
    parsed.ignore !== undefined
      ? [...new Set([...DEFAULT_IGNORE, ...(parsed.ignore as string[])])]
      : defaults.ignore;

  // Merge overrides: defaults first, user wins
  const userOverrides =
    typeof parsed.overrides === "object" &&
    parsed.overrides !== null &&
    !Array.isArray(parsed.overrides)
      ? (parsed.overrides as Record<string, unknown>)
      : {};

  const VALID_OVERRIDE_VALUES = new Set(["safe", "breaking", "changed"]);
  for (const [method, value] of Object.entries(userOverrides)) {
    if (!VALID_OVERRIDE_VALUES.has(value as string)) {
      throw new Error(
        `.depimpact.json overrides["${method}"] must be one of "safe", "breaking", "changed"`,
      );
    }
  }

  const mergedOverrides: Record<string, "safe" | "breaking" | "changed"> = {
    ...defaults.overrides,
    ...(userOverrides as Record<string, "safe" | "breaking" | "changed">),
  };

  // GitHub token: user config file wins over env var
  let githubToken: string | null = defaults.github.token;
  if (
    typeof parsed.github === "object" &&
    parsed.github !== null &&
    !Array.isArray(parsed.github)
  ) {
    const githubSection = parsed.github as Record<string, unknown>;
    if (typeof githubSection.token === "string") {
      githubToken = githubSection.token;
    }
  }

  // Output: user values win
  let outputJson = defaults.output.json;
  let outputVerbose = defaults.output.verbose;
  if (
    typeof parsed.output === "object" &&
    parsed.output !== null &&
    !Array.isArray(parsed.output)
  ) {
    const outputSection = parsed.output as Record<string, unknown>;
    if (typeof outputSection.json === "boolean") {
      outputJson = outputSection.json;
    }
    if (typeof outputSection.verbose === "boolean") {
      outputVerbose = outputSection.verbose;
    }
  }

  return {
    ignore: mergedIgnore,
    overrides: mergedOverrides,
    github: { token: githubToken },
    output: { json: outputJson, verbose: outputVerbose },
  };
}
