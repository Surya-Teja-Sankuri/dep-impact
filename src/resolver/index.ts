import { readFile } from "node:fs/promises";
import path from "node:path";
import fetch, { FetchError } from "node-fetch";

export type ResolvedPackage = {
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  repoUrl: string | null;
};

type JsonObject = Record<string, unknown>;

type RegistryResponse = {
  "dist-tags"?: {
    latest?: unknown;
  };
  versions?: Record<string, unknown>;
  repository?: unknown;
};

/**
 * Resolves the installed version, desired target version, and repository URL
 * for an npm package used in the current project.
 */
export async function resolvePackage(
  packageName: string,
  targetVersion?: string,
): Promise<ResolvedPackage> {
  const currentVersion = await getCurrentInstalledVersion(packageName);
  const registryPackage = await fetchRegistryPackage(packageName);
  const resolvedTargetVersion = getTargetVersion(
    registryPackage,
    packageName,
    targetVersion,
  );

  if (resolvedTargetVersion === currentVersion) {
    throw new Error(
      `Already on latest version ${resolvedTargetVersion}, nothing to check`,
    );
  }

  return {
    packageName,
    currentVersion,
    targetVersion: resolvedTargetVersion,
    repoUrl: getRepositoryUrl(registryPackage),
  };
}

async function getCurrentInstalledVersion(packageName: string): Promise<string> {
  const packageJsonPath = path.join(
    process.cwd(),
    "node_modules",
    packageName,
    "package.json",
  );

  let packageJsonContents: string;
  try {
    packageJsonContents = await readFile(packageJsonPath, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(
        `${packageName} is not installed in this project. Run npm install ${packageName} first.`,
      );
    }

    throw error;
  }

  try {
    const parsed = JSON.parse(packageJsonContents) as unknown;
    const version = getStringField(parsed, "version");

    if (!version) {
      throw new Error();
    }

    return version;
  } catch {
    throw new Error(`Package ${packageName} is not installed in this project`);
  }
}

async function fetchRegistryPackage(packageName: string): Promise<RegistryResponse> {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(registryUrl);
  } catch (error: unknown) {
    if (error instanceof FetchError || error instanceof Error) {
      throw new Error(
        "Could not reach npm registry. Check your internet connection.",
      );
    }

    throw new Error("Could not reach npm registry. Check your internet connection.");
  }

  if (response.status === 404) {
    throw new Error(`Package ${packageName} not found on npm registry`);
  }

  if (!response.ok) {
    throw new Error(
      "Could not reach npm registry. Check your internet connection.",
    );
  }

  try {
    return (await response.json()) as RegistryResponse;
  } catch {
    throw new Error(
      "Could not reach npm registry. Check your internet connection.",
    );
  }
}

function getTargetVersion(
  registryPackage: RegistryResponse,
  packageName: string,
  targetVersion?: string,
): string {
  const versions = registryPackage.versions;

  if (!versions || typeof versions !== "object") {
    throw new Error(`Package ${packageName} not found on npm registry`);
  }

  if (targetVersion) {
    if (!(targetVersion in versions)) {
      throw new Error(`Version ${targetVersion} not found for package ${packageName}`);
    }

    return targetVersion;
  }

  const latest = registryPackage["dist-tags"]?.latest;

  if (typeof latest !== "string" || !(latest in versions)) {
    throw new Error(`Package ${packageName} not found on npm registry`);
  }

  return latest;
}

function getRepositoryUrl(registryPackage: RegistryResponse): string | null {
  const repository = registryPackage.repository;

  if (!isJsonObject(repository)) {
    return null;
  }

  const repositoryUrl = repository.url;
  if (typeof repositoryUrl !== "string" || repositoryUrl.length === 0) {
    return null;
  }

  return cleanRepositoryUrl(repositoryUrl);
}

function cleanRepositoryUrl(repositoryUrl: string): string {
  let cleanedUrl = repositoryUrl;

  if (cleanedUrl.startsWith("git+")) {
    cleanedUrl = cleanedUrl.slice(4);
  }

  if (cleanedUrl.startsWith("git://")) {
    cleanedUrl = `https://${cleanedUrl.slice("git://".length)}`;
  }

  if (cleanedUrl.endsWith(".git")) {
    cleanedUrl = cleanedUrl.slice(0, -4);
  }

  return cleanedUrl;
}

function getStringField(value: unknown, key: string): string | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const field = value[key];
  return typeof field === "string" ? field : null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}
