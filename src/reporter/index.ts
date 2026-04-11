import chalk from "chalk";
import path from "node:path";
import type { ScoreResult, RiskLevel } from "../scorer/index.js";

const SEPARATOR = "─".repeat(49);

const STRATEGY_MESSAGES: Record<ScoreResult["strategy"], string> = {
  "type-diff": "Analysis based on type definitions (accurate)",
  "regex-heuristics": "Analysis based on changelog heuristics (estimated)",
  none: "No type definitions or changelog available — manual review recommended",
};

function colorForRisk(risk: RiskLevel): (text: string) => string {
  switch (risk) {
    case "HIGH":
      return chalk.red;
    case "MEDIUM":
      return chalk.yellow;
    case "LOW":
      return chalk.blue;
    case "NONE":
      return chalk.green;
  }
}

function labelForRisk(risk: RiskLevel): string {
  return colorForRisk(risk)(risk.padEnd(6));
}

/**
 * Prints the upgrade impact report to stdout.
 * Pass json=true for machine-readable output suitable for CI pipelines.
 * Pass verbose=true to show all reasons per file instead of just the first.
 */
export function printReport(
  result: ScoreResult,
  json: boolean,
  verbose = false,
): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { packageName, currentVersion, targetVersion, overall, files, strategy } = result;

  console.log(SEPARATOR);
  console.log(`dep-impact  ${packageName}  ${currentVersion} → ${targetVersion}`);
  console.log(SEPARATOR);

  const affectedFiles = files.filter((f) => f.risk !== "NONE");

  if (affectedFiles.length === 0) {
    console.log(
      `\n  ${chalk.green("NONE")}   No breaking changes detected in your usage.\n`,
    );
  } else {
    console.log("");
    for (const file of affectedFiles) {
      const relFile = path.relative(process.cwd(), file.file);
      const label = labelForRisk(file.risk);

      console.log(`  ${label}  ${relFile}`);

      if (file.affectedMethods.length > 0) {
        console.log(`          methods: ${file.affectedMethods.join(", ")}`);
      }

      const reasons = verbose ? file.reasons : file.reasons.slice(0, 1);
      for (const reason of reasons) {
        console.log(`          → ${reason}`);
      }

      console.log("");
    }
  }

  const overallColor = colorForRisk(overall);
  const filesNote =
    result.totalFilesAffected === 1
      ? "1 file may need changes"
      : `${result.totalFilesAffected} file(s) may need changes`;

  console.log(
    `Overall: ${overallColor(overall)} — ${filesNote}`,
  );
  console.log(STRATEGY_MESSAGES[strategy]);
}
