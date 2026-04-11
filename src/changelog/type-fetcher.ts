import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import fetch, { FetchError } from "node-fetch";
import { glob } from "glob";

export type ExtractedTypes = {
  packageName: string;
  version: string;
  dtsFiles: string[];
  tempDir: string;
  hasTypes: boolean;
};

type PackageVersionResponse = {
  dist?: {
    tarball?: unknown;
  };
};

type TarExtractorModule = {
  x(options: {
    cwd: string;
    strip: number;
    filter: (filePath: string) => boolean;
  }): NodeJS.WritableStream;
};

/**
 * Downloads a package tarball for a specific version and extracts only its
 * declaration files into a temporary directory.
 */
export async function fetchTypeDefinitions(
  packageName: string,
  version: string,
): Promise<ExtractedTypes> {
  const safePackageName = packageName.replace(/[^a-zA-Z0-9._-]/g, "-");
  const tempDir = path.join(
    os.tmpdir(),
    `dep-impact-${safePackageName}-${version}-${Date.now()}`,
  );

  mkdirSync(tempDir, { recursive: true });

  try {
    const tarballUrl = await getTarballUrl(packageName, version);
    const tarballBuffer = await downloadTarball(tarballUrl);
    await extractDeclarationFiles(tarballBuffer, tempDir);

    const dtsFiles = await glob("**/*.d.ts", {
      cwd: tempDir,
      absolute: true,
      nodir: true,
    });

    return {
      packageName,
      version,
      dtsFiles,
      tempDir,
      hasTypes: dtsFiles.length > 0,
    };
  } catch (error: unknown) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Removes the temporary directory used for extracted declaration files.
 */
export async function cleanupTypes(extracted: ExtractedTypes): Promise<void> {
  try {
    rmSync(extracted.tempDir, { recursive: true, force: true });
  } catch {
    // Cleanup should never block the calling flow.
  }
}

async function getTarballUrl(packageName: string, version: string): Promise<string> {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(registryUrl);
  } catch (error: unknown) {
    if (error instanceof FetchError || error instanceof Error) {
      throw new Error(`Could not reach npm registry for ${packageName}@${version}`);
    }

    throw new Error(`Could not reach npm registry for ${packageName}@${version}`);
  }

  if (response.status === 404) {
    throw new Error(`Package ${packageName}@${version} was not found on npm registry`);
  }

  if (!response.ok) {
    throw new Error(`Could not fetch metadata for ${packageName}@${version}`);
  }

  const parsed = (await response.json()) as PackageVersionResponse;
  const tarballUrl = parsed.dist?.tarball;

  if (typeof tarballUrl !== "string" || tarballUrl.length === 0) {
    throw new Error(`No tarball found for ${packageName}@${version}`);
  }

  return tarballUrl;
}

async function downloadTarball(tarballUrl: string): Promise<Buffer> {
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(tarballUrl);
  } catch (error: unknown) {
    if (error instanceof FetchError || error instanceof Error) {
      throw new Error("Could not download package tarball from npm registry");
    }

    throw new Error("Could not download package tarball from npm registry");
  }

  if (!response.ok) {
    throw new Error("Could not download package tarball from npm registry");
  }

  return Buffer.from(await response.arrayBuffer());
}

async function extractDeclarationFiles(
  tarballBuffer: Buffer,
  tempDir: string,
): Promise<void> {
  const tarModuleName = "tar";
  const tarModule = (await import(tarModuleName)) as unknown as TarExtractorModule;
  const extractor = tarModule.x({
    cwd: tempDir,
    strip: 1,
    filter: (filePath: string) => filePath.endsWith(".d.ts"),
  });

  await pipeline(Readable.from(tarballBuffer), extractor);
}
