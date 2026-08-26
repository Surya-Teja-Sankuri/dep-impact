#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import chalk from "chalk";
import { resolvePackage } from "../resolver/index.js";
import { scanProject } from "../scanner/index.js";
import { fetchChangelog } from "../changelog/fetcher.js";
import { parseChangelog } from "../changelog/parser.js";
import { scoreRisk } from "../scorer/index.js";
import { printReport } from "../reporter/index.js";
import { loadConfig } from "../config/index.js";

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../../package.json") as { version: string };

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

/**
 * Reports a terminal no-op state (already up to date, or the package isn't
 * used anywhere) in whichever shape the caller asked for, so --json output
 * stays valid JSON on every code path.
 */
function reportNoOp(
  json: boolean,
  info: {
    packageName: string;
    currentVersion: string;
    targetVersion: string;
    message: string;
    totalFilesScanned?: number;
  },
): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          packageName: info.packageName,
          currentVersion: info.currentVersion,
          targetVersion: info.targetVersion,
          overall: "NONE",
          totalFilesAffected: 0,
          totalFilesScanned: info.totalFilesScanned ?? 0,
          strategy: "none",
          files: [],
          message: info.message,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(info.message);
  }
}

const program = new Command();

program
  .name("dep-impact")
  .version(packageVersion)
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

      // Known before config loads, so a config-load failure can still report
      // errors in the shape the caller asked for.
      let effectiveJson = jsonMode;

      try {
        const config = loadConfig(process.cwd());
        effectiveJson = jsonMode || config.output.json;
        const effectiveVerbose = verboseMode || config.output.verbose;

        const { name: packageName, version: targetVersion } =
          parsePackageArg(packageWithVersion);

        if (!effectiveJson) {
          console.log(`Analyzing ${packageName} upgrade...`);
        }

        const resolved = await resolvePackage(packageName, targetVersion);

        if (resolved.alreadyUpToDate) {
          reportNoOp(effectiveJson, {
            packageName: resolved.packageName,
            currentVersion: resolved.currentVersion,
            targetVersion: resolved.targetVersion,
            message: `Already on version ${resolved.currentVersion} — nothing to upgrade.`,
          });
          process.exit(0);
        }

        const usageMap = await scanProject(packageName, process.cwd(), config.ignore);

        if (usageMap.usages.length === 0) {
          reportNoOp(effectiveJson, {
            packageName: resolved.packageName,
            currentVersion: resolved.currentVersion,
            targetVersion: resolved.targetVersion,
            message: `${packageName} is not used in this project.`,
            totalFilesScanned: usageMap.totalFilesScanned,
          });
          process.exit(0);
        }

        const fetched = await fetchChangelog(
          resolved.packageName,
          resolved.repoUrl,
          resolved.currentVersion,
          resolved.targetVersion,
          config.github.token,
        );

        const parsed = await parseChangelog(
          resolved.packageName,
          resolved.currentVersion,
          resolved.targetVersion,
          fetched.content,
          { silent: effectiveJson },
        );

        const scored = scoreRisk(
          usageMap,
          parsed,
          resolved.currentVersion,
          resolved.targetVersion,
          config.overrides,
          usageMap.totalFilesScanned,
        );

        printReport(scored, effectiveJson, effectiveVerbose);

        if (fixMode) {
          const risk = scored.overall;
          if (risk === "NONE" || risk === "LOW") {
            if (!effectiveJson) {
              console.log(
                `Running npm install ${resolved.packageName}@${resolved.targetVersion}...`,
              );
            }
            // On Windows, npm is a "npm.cmd" shim, and Node cannot spawn
            // .cmd/.bat files directly without shell:true (it throws
            // EINVAL). packageName and targetVersion are both validated /
            // registry-sourced by this point, so there's no unescaped
            // user input reaching the shell here.
            const isWindows = process.platform === "win32";
            execFileSync(
              isWindows ? "npm.cmd" : "npm",
              ["install", `${resolved.packageName}@${resolved.targetVersion}`],
              { stdio: effectiveJson ? "ignore" : "inherit", shell: isWindows },
            );
          } else if (!effectiveJson) {
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

        if (effectiveJson) {
          console.log(JSON.stringify({ error: message }, null, 2));
        } else {
          console.error(chalk.red(message));
        }

        process.exit(3);
      }
    },
  );

program.parse();
