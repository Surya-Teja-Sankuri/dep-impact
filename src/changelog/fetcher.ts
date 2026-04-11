import fetch, { FetchError, Headers } from "node-fetch";
import { gt, lte, valid } from "semver";

export type FetchedChangelog = {
  content: string;
  source: "github-releases" | "changelog-file" | "npm-registry";
  repoUrl: string | null;
};

type GitHubRelease = {
  tag_name?: unknown;
  body?: unknown;
};

type NpmRegistryResponse = {
  readme?: unknown;
};

type RepoCoordinates = {
  owner: string;
  repo: string;
};

/**
 * Fetches raw changelog text for a package by trying GitHub releases, a
 * repository changelog file, and finally the npm registry README.
 */
export async function fetchChangelog(
  packageName: string,
  repoUrl: string | null,
  currentVersion: string,
  targetVersion: string,
): Promise<FetchedChangelog> {
  const repoCoordinates = getRepoCoordinates(repoUrl);

  if (repoCoordinates && repoUrl) {
    const githubReleases = await fetchFromGitHubReleases(
      repoCoordinates,
      repoUrl,
      currentVersion,
      targetVersion,
    );
    if (githubReleases) {
      return githubReleases;
    }

    const changelogFile = await fetchFromChangelogFile(repoCoordinates, repoUrl);
    if (changelogFile) {
      return changelogFile;
    }
  }

  const npmRegistryContent = await fetchFromNpmRegistry(packageName, repoUrl);
  if (npmRegistryContent) {
    return npmRegistryContent;
  }

  return {
    content: "",
    source: "npm-registry",
    repoUrl,
  };
}

async function fetchFromGitHubReleases(
  repoCoordinates: RepoCoordinates,
  repoUrl: string,
  currentVersion: string,
  targetVersion: string,
): Promise<FetchedChangelog | null> {
  const releasesUrl = `https://api.github.com/repos/${repoCoordinates.owner}/${repoCoordinates.repo}/releases`;
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });

  if (process.env.GITHUB_TOKEN) {
    headers.set("Authorization", `Bearer ${process.env.GITHUB_TOKEN}`);
  }

  try {
    const response = await fetch(releasesUrl, { headers });

    if (response.status === 403 || response.status === 429) {
      console.debug(
        "GitHub API rate limited. Set GITHUB_TOKEN in .env for higher limits.",
      );
      return null;
    }

    if (response.status !== 200) {
      console.debug(`GitHub releases request failed with status ${response.status}.`);
      return null;
    }

    const parsed = (await response.json()) as unknown;
    if (!Array.isArray(parsed)) {
      console.debug("GitHub releases response was not an array.");
      return null;
    }

    const matchingReleaseBodies = parsed
      .filter(isGitHubRelease)
      .map((release) => {
        const normalizedVersion = normalizeVersionTag(release.tag_name);
        if (!normalizedVersion || !valid(normalizedVersion)) {
          return null;
        }

        if (!gt(normalizedVersion, currentVersion) || !lte(normalizedVersion, targetVersion)) {
          return null;
        }

        return {
          version: normalizedVersion,
          body: typeof release.body === "string" ? release.body.trim() : "",
        };
      })
      .filter(
        (
          release,
        ): release is {
          version: string;
          body: string;
        } => release !== null,
      )
      .sort((left, right) => compareVersionsDescending(left.version, right.version))
      .map((release) => release.body)
      .filter((body) => body.length > 0);

    if (matchingReleaseBodies.length === 0) {
      return null;
    }

    return {
      content: matchingReleaseBodies.join("\n\n"),
      source: "github-releases",
      repoUrl,
    };
  } catch (error: unknown) {
    logNetworkDebug("GitHub releases", error);
    return null;
  }
}

async function fetchFromChangelogFile(
  repoCoordinates: RepoCoordinates,
  repoUrl: string,
): Promise<FetchedChangelog | null> {
  const changelogUrls = [
    `https://raw.githubusercontent.com/${repoCoordinates.owner}/${repoCoordinates.repo}/main/CHANGELOG.md`,
    `https://raw.githubusercontent.com/${repoCoordinates.owner}/${repoCoordinates.repo}/master/CHANGELOG.md`,
  ];

  for (const changelogUrl of changelogUrls) {
    try {
      const response = await fetch(changelogUrl);
      if (response.status !== 200) {
        console.debug(`Changelog file request failed with status ${response.status}.`);
        continue;
      }

      const content = await response.text();
      if (!content) {
        continue;
      }

      return {
        content,
        source: "changelog-file",
        repoUrl,
      };
    } catch (error: unknown) {
      logNetworkDebug("raw changelog", error);
    }
  }

  return null;
}

async function fetchFromNpmRegistry(
  packageName: string,
  repoUrl: string | null,
): Promise<FetchedChangelog | null> {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;

  try {
    const response = await fetch(registryUrl);
    if (response.status !== 200) {
      console.debug(`npm registry request failed with status ${response.status}.`);
      return null;
    }

    const parsed = (await response.json()) as NpmRegistryResponse;
    if (typeof parsed.readme !== "string" || parsed.readme.trim().length === 0) {
      return null;
    }

    return {
      content: parsed.readme,
      source: "npm-registry",
      repoUrl,
    };
  } catch (error: unknown) {
    logNetworkDebug("npm registry", error);
    return null;
  }
}

function getRepoCoordinates(repoUrl: string | null): RepoCoordinates | null {
  if (!repoUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(repoUrl);
    if (parsedUrl.hostname !== "github.com") {
      return null;
    }

    const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
    if (pathSegments.length < 2) {
      return null;
    }

    return {
      owner: pathSegments[0],
      repo: pathSegments[1],
    };
  } catch {
    return null;
  }
}

function normalizeVersionTag(tagName: unknown): string | null {
  if (typeof tagName !== "string") {
    return null;
  }

  return tagName.startsWith("v") ? tagName.slice(1) : tagName;
}

function compareVersionsDescending(left: string, right: string): number {
  if (gt(left, right)) {
    return -1;
  }

  if (gt(right, left)) {
    return 1;
  }

  return 0;
}

function isGitHubRelease(value: unknown): value is GitHubRelease {
  return typeof value === "object" && value !== null;
}

function logNetworkDebug(source: string, error: unknown): void {
  if (error instanceof FetchError || error instanceof Error) {
    console.debug(`${source} fetch failed: ${error.message}`);
    return;
  }

  console.debug(`${source} fetch failed.`);
}
