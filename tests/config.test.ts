import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/index.js";

const DEFAULT_IGNORE = ["node_modules", "dist", "build", ".git", "coverage"];

describe("loadConfig", () => {
  let dir: string;
  let originalGithubToken: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-impact-test-"));
    originalGithubToken = process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGithubToken;
    }
  });

  function writeConfig(content: string) {
    fs.writeFileSync(path.join(dir, ".depimpact.json"), content, "utf8");
  }

  describe("no config file present", () => {
    it("returns full defaults when .depimpact.json does not exist", () => {
      delete process.env.GITHUB_TOKEN;
      const config = loadConfig(dir);
      expect(config.ignore).toEqual(DEFAULT_IGNORE);
      expect(config.overrides).toEqual({});
      expect(config.github.token).toBeNull();
      expect(config.output).toEqual({ json: false, verbose: false });
    });

    it("uses GITHUB_TOKEN env var as default token when no config file exists", () => {
      process.env.GITHUB_TOKEN = "env-token-123";
      const config = loadConfig(dir);
      expect(config.github.token).toBe("env-token-123");
    });
  });

  describe("malformed JSON", () => {
    it("throws an Error with exact message on invalid JSON", () => {
      writeConfig("{ not valid json ");
      expect(() => loadConfig(dir)).toThrowError(
        "Invalid .depimpact.json — must be valid JSON",
      );
    });
  });

  describe("ignore field", () => {
    it("throws when ignore is not an array (e.g. a string)", () => {
      writeConfig(JSON.stringify({ ignore: "not-an-array" }));
      expect(() => loadConfig(dir)).toThrowError(
        ".depimpact.json ignore field must be an array",
      );
    });

    it("throws when ignore is an object rather than an array", () => {
      writeConfig(JSON.stringify({ ignore: { foo: "bar" } }));
      expect(() => loadConfig(dir)).toThrowError(
        ".depimpact.json ignore field must be an array",
      );
    });

    it("throws when ignore contains non-string elements", () => {
      writeConfig(JSON.stringify({ ignore: [1, null] }));
      expect(() => loadConfig(dir)).toThrowError(
        ".depimpact.json ignore field must be an array of strings",
      );
    });

    it("throws when ignore mixes strings and non-strings", () => {
      writeConfig(JSON.stringify({ ignore: ["valid", 42] }));
      expect(() => loadConfig(dir)).toThrowError(
        ".depimpact.json ignore field must be an array of strings",
      );
    });

    it("merges a valid ignore array with the built-in defaults", () => {
      writeConfig(JSON.stringify({ ignore: ["custom-dir"] }));
      const config = loadConfig(dir);
      expect(config.ignore).toEqual(
        expect.arrayContaining([...DEFAULT_IGNORE, "custom-dir"]),
      );
      expect(config.ignore).toHaveLength(DEFAULT_IGNORE.length + 1);
    });

    it("dedupes when user ignore list overlaps with defaults", () => {
      writeConfig(JSON.stringify({ ignore: ["node_modules", "coverage", "custom-dir"] }));
      const config = loadConfig(dir);
      expect(config.ignore).toHaveLength(DEFAULT_IGNORE.length + 1);
      expect(new Set(config.ignore).size).toBe(config.ignore.length);
    });

    it("returns unmodified defaults when ignore is omitted entirely", () => {
      writeConfig(JSON.stringify({ output: { json: true } }));
      const config = loadConfig(dir);
      expect(config.ignore).toEqual(DEFAULT_IGNORE);
    });
  });

  describe("overrides field", () => {
    it("falls back to empty object when overrides is not an object (a string)", () => {
      writeConfig(JSON.stringify({ overrides: "not-an-object" }));
      const config = loadConfig(dir);
      expect(config.overrides).toEqual({});
    });

    it("falls back to empty object when overrides is an array", () => {
      writeConfig(JSON.stringify({ overrides: ["safe", "breaking"] }));
      const config = loadConfig(dir);
      expect(config.overrides).toEqual({});
    });

    it("falls back to empty object when overrides is null", () => {
      writeConfig(JSON.stringify({ overrides: null }));
      const config = loadConfig(dir);
      expect(config.overrides).toEqual({});
    });

    it("throws a descriptive error naming the bad key for an invalid override value", () => {
      writeConfig(
        JSON.stringify({ overrides: { someMethod: "not-a-valid-value" } }),
      );
      expect(() => loadConfig(dir)).toThrowError(
        '.depimpact.json overrides["someMethod"] must be one of "safe", "breaking", "changed"',
      );
    });

    it("accepts all three valid override values and merges them through", () => {
      writeConfig(
        JSON.stringify({
          overrides: {
            "pkg.methodA": "safe",
            "pkg.methodB": "breaking",
            "pkg.methodC": "changed",
          },
        }),
      );
      const config = loadConfig(dir);
      expect(config.overrides).toEqual({
        "pkg.methodA": "safe",
        "pkg.methodB": "breaking",
        "pkg.methodC": "changed",
      });
    });
  });

  describe("github.token precedence", () => {
    it("prefers the config file token over the GITHUB_TOKEN env var", () => {
      process.env.GITHUB_TOKEN = "env-token";
      writeConfig(JSON.stringify({ github: { token: "config-token" } }));
      const config = loadConfig(dir);
      expect(config.github.token).toBe("config-token");
    });

    it("falls back to the env var when config omits github.token", () => {
      process.env.GITHUB_TOKEN = "env-token";
      writeConfig(JSON.stringify({ github: {} }));
      const config = loadConfig(dir);
      expect(config.github.token).toBe("env-token");
    });

    it("falls back to env/default when github section is malformed (a string)", () => {
      process.env.GITHUB_TOKEN = "env-token";
      writeConfig(JSON.stringify({ github: "not-an-object" }));
      const config = loadConfig(dir);
      expect(config.github.token).toBe("env-token");
    });

    it("falls back to env/default when github section is an array", () => {
      process.env.GITHUB_TOKEN = "env-token";
      writeConfig(JSON.stringify({ github: ["not", "valid"] }));
      const config = loadConfig(dir);
      expect(config.github.token).toBe("env-token");
    });

    it("ignores a non-string token in the github section and falls back to env", () => {
      process.env.GITHUB_TOKEN = "env-token";
      writeConfig(JSON.stringify({ github: { token: 12345 } }));
      const config = loadConfig(dir);
      expect(config.github.token).toBe("env-token");
    });

    it("resolves to null when neither config nor env provide a token", () => {
      delete process.env.GITHUB_TOKEN;
      writeConfig(JSON.stringify({ github: {} }));
      const config = loadConfig(dir);
      expect(config.github.token).toBeNull();
    });
  });

  describe("output.json / output.verbose", () => {
    it("merges output.json alone without resetting verbose", () => {
      writeConfig(JSON.stringify({ output: { json: true } }));
      const config = loadConfig(dir);
      expect(config.output).toEqual({ json: true, verbose: false });
    });

    it("merges output.verbose alone without resetting json", () => {
      writeConfig(JSON.stringify({ output: { verbose: true } }));
      const config = loadConfig(dir);
      expect(config.output).toEqual({ json: false, verbose: true });
    });

    it("merges both output fields when both are provided", () => {
      writeConfig(JSON.stringify({ output: { json: true, verbose: true } }));
      const config = loadConfig(dir);
      expect(config.output).toEqual({ json: true, verbose: true });
    });

    it("ignores non-boolean output.json and falls back to default", () => {
      writeConfig(JSON.stringify({ output: { json: "yes" } }));
      const config = loadConfig(dir);
      expect(config.output.json).toBe(false);
    });

    it("ignores non-boolean output.verbose and falls back to default", () => {
      writeConfig(JSON.stringify({ output: { verbose: "yes" } }));
      const config = loadConfig(dir);
      expect(config.output.verbose).toBe(false);
    });

    it("falls back to defaults entirely when output section is malformed", () => {
      writeConfig(JSON.stringify({ output: "not-an-object" }));
      const config = loadConfig(dir);
      expect(config.output).toEqual({ json: false, verbose: false });
    });
  });

  describe("unreadable config file", () => {
    it("throws a descriptive error when .depimpact.json is a directory (EISDIR)", () => {
      fs.mkdirSync(path.join(dir, ".depimpact.json"));
      expect(() => loadConfig(dir)).toThrowError(/^Could not read \.depimpact\.json: /);
    });
  });

  describe("full config combining all fields", () => {
    it("merges a complete, valid config file correctly across all fields", () => {
      delete process.env.GITHUB_TOKEN;
      writeConfig(
        JSON.stringify({
          ignore: ["tmp"],
          overrides: { "axios.get": "breaking" },
          github: { token: "full-token" },
          output: { json: true, verbose: false },
        }),
      );
      const config = loadConfig(dir);
      expect(config.ignore).toEqual(
        expect.arrayContaining([...DEFAULT_IGNORE, "tmp"]),
      );
      expect(config.overrides).toEqual({ "axios.get": "breaking" });
      expect(config.github.token).toBe("full-token");
      expect(config.output).toEqual({ json: true, verbose: false });
    });
  });
});
