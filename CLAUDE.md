# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # Compile TypeScript → dist/ (required before running CLI)
npm run lint       # Type-check only, no emit (tsc --noEmit)
npm run dev        # Run CLI directly via ts-node (no build step needed)
npm test           # Run tests with vitest
```

**Link for local CLI testing:**
```bash
npm link           # Register dep-impact globally from local build
dep-impact upgrade axios
```

There are no tests yet (`tests/` only has `.gitkeep`). When adding tests, use vitest and place them in `tests/`.

## Architecture

`dep-impact` is a CLI tool that analyzes the blast radius of an npm package upgrade. The pipeline runs sequentially through six modules:

```
resolvePackage → scanProject → fetchChangelog → parseChangelog → scoreRisk → printReport
```

### Module responsibilities

| Module | File | Role |
|---|---|---|
| **CLI** | `src/cli/index.ts` | Commander setup, orchestrates the full pipeline, handles `--json/--verbose/--fix` flags and exit codes |
| **Config** | `src/config/index.ts` | Loads `.depimpact.json` from project root, merges with defaults |
| **Resolver** | `src/resolver/index.ts` | Reads current version from `node_modules`, fetches target version metadata from npm registry |
| **Scanner** | `src/scanner/index.ts` | Walks `.ts/.tsx/.js/.jsx` files using the TypeScript Compiler API AST to find all imports/usages of the target package |
| **Changelog / Fetcher** | `src/changelog/fetcher.ts` | Fetches raw changelog text from GitHub releases or `CHANGELOG.md` |
| **Changelog / Parser** | `src/changelog/parser.ts` | Orchestrator: tries type-diff first, falls back to regex heuristics on changelog text |
| **Type Fetcher** | `src/changelog/type-fetcher.ts` | Downloads npm tarballs for both versions, extracts `.d.ts` files to temp dirs |
| **Type Differ** | `src/changelog/type-differ.ts` | Uses `ts.createSourceFile` to extract exported members (functions, classes, interfaces, types, variables) and diffs signatures between versions |
| **Scorer** | `src/scorer/index.ts` | Cross-references per-file usage (from scanner) against breaking changes (from parser), assigns `HIGH/MEDIUM/LOW/NONE` risk per file and overall |
| **Reporter** | `src/reporter/index.ts` | Prints colored terminal output (chalk) or JSON |

### Key data flow types

- `UsageMap` — output of scanner: `{ packageName, usages: { file, method }[] }`
- `ParsedChangelog` — output of parser: `{ breakingChanges: BreakingChange[], strategy: "type-diff" | "regex-heuristics" | "none" }`
- `BreakingChange` — `{ identifier, description, severity: "breaking" | "changed" | "deprecated" }`
- `ScoreResult` — output of scorer, input to reporter: per-file `FileRisk[]` + `overall` risk + metadata

### Analysis strategy priority

1. **type-diff** — download `.d.ts` files for both versions via npm tarball; diff exported API surface using TypeScript Compiler API. Most accurate.
2. **regex-heuristics** — scan changelog text for `BREAKING_SIGNALS` / `CHANGED_SIGNALS` keyword lists. Fallback.
3. **none** — neither types nor changelog available.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | NONE or LOW risk |
| `1` | MEDIUM risk |
| `2` | HIGH risk |
| `3` | Error (package not installed, network failure, etc.) |

### Configuration file (`.depimpact.json`)

Optional, placed in the project root being analyzed. Fields: `ignore` (paths to exclude from scanning), `overrides` (per-method risk overrides), `github.token` (for private repos), `output.json`, `output.verbose`.

### Module system

The project uses `"type": "module"` (ESM). All internal imports must use `.js` extensions (e.g., `import { foo } from "../bar/index.js"`), even when the source file is `.ts`. TypeScript is configured with `"module": "NodeNext"`.
