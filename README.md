# dep-impact

**Know what breaks before you upgrade. Not after.**

`dep-impact` is a CLI tool that tells you exactly which files and methods in your codebase will be affected by upgrading an npm package — before you run `npm install`.

```
$ dep-impact upgrade axios

Analyzing axios upgrade...
─────────────────────────────────────────────────
dep-impact  axios  0.27.2 → 1.0.0
─────────────────────────────────────────────────

  MEDIUM  src/api/client.ts
          methods: axios.create, axios.defaults.headers
          → AxiosStatic signature changed in 1.0.0

  LOW     src/utils/request.ts
          methods: axios.get
          → No direct breaking change detected

Overall: MEDIUM — 1 file(s) may need changes
Analysis based on type definitions (accurate)
```

---

## Why dep-impact?

| Tool | What it does |
|---|---|
| `npm audit` | Finds security vulnerabilities |
| `npm outdated` | Shows available versions |
| `npm-check-updates` | Bumps version numbers |
| **`dep-impact`** | Shows **which files in your code** break when you upgrade |

No other tool tells you the blast radius of an upgrade in your specific codebase. `dep-impact` fills that gap.

---

## How it works

1. **Resolves** the package — finds your current installed version and fetches the target version from npm registry
2. **Scans** your project — walks every `.ts`, `.tsx`, `.js`, `.jsx` file and finds every import of the package using the TypeScript Compiler API
3. **Diffs type definitions** — downloads `.d.ts` files for both versions from npm and diffs exported functions, classes, interfaces, and types
4. **Cross-references** — matches each breaking change against the methods your code actually uses
5. **Reports** — prints a colored terminal report (or JSON for CI) showing per-file risk

The type definition diff is the primary strategy. It falls back to changelog text heuristics when types are unavailable. Everything runs offline after the initial download — no LLM, no AI, no API keys required.

---

## Installation

### Global install (recommended)

```bash
npm install -g dep-impact
```

### Or run without installing

```bash
npx dep-impact upgrade axios
```

**Requirements:** Node.js 20+

---

## Usage

### Basic upgrade check

```bash
dep-impact upgrade <package>
dep-impact upgrade <package>@<version>
```

Check what breaks if you upgrade to the **latest** version:

```bash
dep-impact upgrade axios
```

Check what breaks if you upgrade to a **specific** version:

```bash
dep-impact upgrade axios@1.0.0
dep-impact upgrade lodash@4.17.21
dep-impact upgrade @types/node@20.0.0
```

### Options

| Flag | Description |
|---|---|
| `--json` | Output machine-readable JSON (no colors, suitable for CI) |
| `--verbose` | Show all breaking change details per file, not just the first |
| `--fix` | Auto-run `npm install` if risk is NONE or LOW |

```bash
# CI pipeline — parse JSON output and check exit code
dep-impact upgrade axios --json

# See every breaking change reason
dep-impact upgrade axios --verbose

# Auto-install only if safe
dep-impact upgrade axios --fix
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | NONE or LOW risk — safe to upgrade |
| `1` | MEDIUM risk — review flagged files before upgrading |
| `2` | HIGH risk — breaking changes detected in your code |
| `3` | Error — package not installed, network failure, etc. |

Exit codes make `dep-impact` composable in CI pipelines:

```bash
dep-impact upgrade axios || echo "Upgrade blocked: breaking changes detected"
```

---

## CI Integration

### GitHub Actions

```yaml
- name: Check upgrade impact
  run: |
    npm install -g dep-impact
    dep-impact upgrade axios --json > impact.json
    cat impact.json
  # Exit code 2 = HIGH risk, fails the step
```

### Pre-upgrade gate

```bash
#!/bin/bash
dep-impact upgrade "$1"
EXIT=$?

if [ $EXIT -eq 2 ]; then
  echo "HIGH risk — aborting upgrade"
  exit 1
elif [ $EXIT -eq 1 ]; then
  echo "MEDIUM risk — review the files above, then upgrade manually"
  exit 1
else
  npm install "$1@latest"
fi
```

---

## JSON output format

```bash
dep-impact upgrade axios --json
```

```json
{
  "packageName": "axios",
  "currentVersion": "0.27.2",
  "targetVersion": "1.0.0",
  "overall": "MEDIUM",
  "totalFilesAffected": 1,
  "totalFilesScanned": 3,
  "strategy": "type-diff",
  "files": [
    {
      "file": "src/api/client.ts",
      "risk": "MEDIUM",
      "affectedMethods": ["axios.create", "axios.defaults.headers"],
      "reasons": [
        "AxiosStatic signature changed: ...",
        "HeadersDefaults signature changed: ..."
      ]
    }
  ]
}
```

---

## Configuration

Create an optional `.depimpact.json` in your project root to customize behavior. All fields are optional.

```json
{
  "ignore": ["src/generated", "src/__mocks__"],
  "overrides": {
    "axios.get": "safe"
  },
  "github": {
    "token": "ghp_your_token_here"
  },
  "output": {
    "json": false,
    "verbose": false
  }
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `ignore` | `string[]` | Paths to exclude from scanning (merged with defaults: `node_modules`, `dist`, `build`, `.git`, `coverage`) |
| `overrides` | `Record<string, "safe" \| "breaking" \| "changed">` | Override the risk classification of specific methods |
| `github.token` | `string` | GitHub token for fetching changelogs from private repos (also reads from `GITHUB_TOKEN` env var) |
| `output.json` | `boolean` | Always output JSON (same as passing `--json`) |
| `output.verbose` | `boolean` | Always show verbose output (same as passing `--verbose`) |

### GitHub token priority

1. `github.token` in `.depimpact.json`
2. `GITHUB_TOKEN` environment variable
3. Unauthenticated (rate-limited to 60 requests/hour)

---

## How risk levels are assigned

| Level | When |
|---|---|
| **HIGH** | A method your code uses was **removed** or has a **breaking** type change |
| **MEDIUM** | A method your code uses has a **changed** signature |
| **LOW** | A method your code uses is **deprecated** |
| **NONE** | No overlap between your usage and detected changes |

Risk is assigned per file and rolled up to an overall project risk.

---

## Analysis strategies

`dep-impact` tries the most accurate strategy first:

1. **Type diff** (`type-diff`) — Downloads `.d.ts` files for both versions from npm and diffs them using the TypeScript Compiler API. This is the most accurate strategy and works for any package that ships types (either bundled or via `@types/`). Output shows *"Analysis based on type definitions (accurate)"*.

2. **Changelog heuristics** (`regex-heuristics`) — Falls back to fetching the GitHub release notes or `CHANGELOG.md` and applying regex patterns to find breaking change signals. Less precise. Output shows *"Analysis based on changelog heuristics (estimated)"*.

3. **None** — If neither types nor changelog are available, reports `NONE` with a manual review recommendation.

---

## Development

### Setup

```bash
git clone https://github.com/your-username/dep-impact
cd dep-impact
npm install
```

### Build

```bash
npm run build        # compiles TypeScript to dist/
npm run lint         # type-check only, no emit
```

### Local testing

```bash
npm link             # registers dep-impact globally from local build
dep-impact upgrade axios
```

### Project structure

```
src/
├── cli/index.ts          # Entry point — wires all modules, commander setup
├── config/index.ts       # Loads .depimpact.json, merges with defaults
├── resolver/index.ts     # Finds current version, fetches target from npm registry
├── scanner/index.ts      # Walks project files, extracts package usage via TS AST
├── changelog/
│   ├── fetcher.ts        # Fetches changelog text from GitHub or npm
│   ├── parser.ts         # Orchestrates type diff → heuristic fallback
│   ├── type-fetcher.ts   # Downloads npm tarball, extracts .d.ts files
│   └── type-differ.ts    # Diffs exported types between versions
├── scorer/index.ts       # Cross-references usage vs breaking changes, assigns risk
└── reporter/index.ts     # Prints colored terminal output or JSON
```

---

## Limitations

- **Requires the package to be installed** — `dep-impact` reads the current version from `node_modules`. Run `npm install` before using it.
- **Dynamic usage is not detected** — if your code constructs method names at runtime (e.g. `obj[methodName]()`), those usages won't be scanned.
- **Monorepo workspaces** — works on a single package root. Point it at a specific workspace directory if needed.
- **Private packages** — type diffing works if types are bundled in the tarball. Changelog fetching from private GitHub repos requires a `GITHUB_TOKEN`.

---

## License

MIT License

Copyright (c) 2026 Surya Teja Sankuri

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
