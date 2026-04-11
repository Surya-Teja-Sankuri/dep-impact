#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { resolvePackage } from "../resolver/index.js";
import { scanProject } from "../scanner/index.js";
import { fetchChangelog } from "../changelog/fetcher.js";
import { parseChangelog } from "../changelog/parser.js";
import { scoreRisk } from "../scorer/index.js";
import { printReport } from "../reporter/index.js";
import { loadConfig } from "../config/index.js";

/**
 * Parses a package argument that may include a version tag.
 * Handles scoped packages correctly:
 *   "axios@1.0.0"       → { name: "axios",        version: "1.0.0" }
 *   "@scope/pkg@1.0.0"  → { name: "@scope/pkg",   version: "1.0.0" }
 *   "axios"             → { name: "axios",         version: undefined }
 */
export function parsePackageArg(
  input: string,
): { name: string; version: string | undefined } {
  // Find the last "@" that isn't the leading character of a scoped package
  const atIndex = input.lastIndexOf("@");
  if (atIndex > 0) {
    return {
      name: input.slice(0, atIndex),
      version: input.slice(atIndex + 1),
    };
  }
  return { name: input, version: undefined };
}

const program = new Command();

program
  .name("dep-impact")
  .version("0.1.0")
  .description("Know what breaks before you upgrade. Not after.");

program
  .command("upgrade <packageWithVersion>")
  .description("Analyze the impact of upgrading a package")
  .option("--json", "output machine-readable JSON, no colors")
  .option("--verbose", "show all details including raw type signatures")
  .option(
    "--fix",
    "run npm install automatically if overall risk is NONE or LOW",
  )
  .action(
    async (
      packageWithVersion: string,
      options: { json?: boolean; verbose?: boolean; fix?: boolean },
    ) => {
      const jsonMode = options.json === true;
      const verboseMode = options.verbose === true;
      const fixMode = options.fix === true;

      try {
        const config = loadConfig(process.cwd());
        const effectiveJson = jsonMode || config.output.json;
        const effectiveVerbose = verboseMode || config.output.verbose;

        const { name: packageName, version: targetVersion } =
          parsePackageArg(packageWithVersion);

        if (!effectiveJson) {
          console.log(`Analyzing ${packageName} upgrade...`);
        }

        const resolved = await resolvePackage(packageName, targetVersion);
        const usageMap = await scanProject(packageName, process.cwd());

        if (usageMap.usages.length === 0) {
          console.log(`${packageName} is not used in this project`);
          process.exit(0);
        }

        const fetched = await fetchChangelog(
          resolved.packageName,
          resolved.repoUrl,
          resolved.currentVersion,
          resolved.targetVersion,
        );

        const parsed = await parseChangelog(
          resolved.packageName,
          resolved.currentVersion,
          resolved.targetVersion,
          fetched.content,
        );

        const scored = scoreRisk(
          usageMap,
          parsed,
          resolved.currentVersion,
          resolved.targetVersion,
        );

        printReport(scored, effectiveJson, effectiveVerbose);

        if (fixMode) {
          const risk = scored.overall;
          if (risk === "NONE" || risk === "LOW") {
            console.log(
              `Running npm install ${resolved.packageName}@${resolved.targetVersion}...`,
            );
            execSync(
              `npm install ${resolved.packageName}@${resolved.targetVersion}`,
              { stdio: "inherit" },
            );
          } else {
            console.log(
              "Skipping auto-install — risk is too high. Review files first.",
            );
          }
        }

        const risk = scored.overall;
        if (risk === "HIGH") {
          process.exit(2);
        } else if (risk === "MEDIUM") {
          process.exit(1);
        } else {
          process.exit(0);
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(chalk.red(message));
        process.exit(3);
      }
    },
  );

program.parse();
