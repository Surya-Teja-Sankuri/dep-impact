import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "glob";
import ts from "typescript";

export type Usage = {
  method: string;
  file: string;
  line: number;
};

export type UsageMap = {
  packageName: string;
  usages: Usage[];
};

type ImportBindings = {
  aliases: Set<string>;
  namedImports: Map<string, string>;
};

type ReExportedBindings = {
  named: Set<string>;    // names of named exports re-exported from the package (e.g. "get", "post")
  defaults: Set<string>; // names under which the package default is re-exported (e.g. "axios")
  wildcard: boolean;     // true when "export * from 'packageName'" is present
};

type ReExportMap = Map<string, ReExportedBindings>; // absolute file path → bindings

const SKIPPED_DIRECTORIES = [
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  ".next",
  "out",
];

const TOOL_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Scans a project for imports from a package and records the package methods
 * and properties used at each file and line location.
 */
export async function scanProject(
  packageName: string,
  projectRoot: string,
): Promise<UsageMap> {
  const files = await glob("**/*.{ts,tsx,js,jsx}", {
    cwd: projectRoot,
    absolute: true,
    nodir: true,
    ignore: SKIPPED_DIRECTORIES.map((directory) => `**/${directory}/**`),
  });

  const usages: Usage[] = [];
  const seenUsages = new Set<string>();

  const relevantFiles = files.filter((filePath) => !isDepImpactFile(filePath));

  const reExportMap = await buildReExportMap(packageName, relevantFiles);

  for (const filePath of relevantFiles) {
    const fileUsages = await scanFile(packageName, filePath, reExportMap);

    for (const usage of fileUsages) {
      const usageKey = `${usage.method}:${usage.file}:${usage.line}`;
      if (seenUsages.has(usageKey)) {
        continue;
      }

      seenUsages.add(usageKey);
      usages.push(usage);
    }
  }

  if (usages.length === 0) {
    console.log(`No usages of ${packageName} found in project`);
  }

  return {
    packageName,
    usages,
  };
}

async function scanFile(
  packageName: string,
  filePath: string,
  reExportMap: ReExportMap,
): Promise<Usage[]> {
  const sourceText = await readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const bindings = findImportBindings(sourceFile, packageName, filePath, reExportMap);

  if (bindings.aliases.size === 0 && bindings.namedImports.size === 0) {
    return [];
  }

  const usages: Usage[] = [];
  const seenUsages = new Set<string>();

  visitNodes(sourceFile, (node) => {
    if (ts.isPropertyAccessExpression(node) && isOutermostPropertyAccess(node)) {
      const chain = getPropertyChain(node);
      if (chain && chain.length > 1) {
        if (bindings.aliases.has(chain[0])) {
          // Default import / namespace import alias: ax.get → axios.get
          addUsage(
            usages,
            seenUsages,
            {
              method: `${packageName}.${chain.slice(1).join(".")}`,
              file: filePath,
              line: getLineNumber(sourceFile, node),
            },
          );
        } else {
          // Named import used with property access: defaults.headers → axios.defaults.headers
          const namedImportedMember = bindings.namedImports.get(chain[0]);
          if (namedImportedMember) {
            addUsage(
              usages,
              seenUsages,
              {
                method: `${packageName}.${namedImportedMember}.${chain.slice(1).join(".")}`,
                file: filePath,
                line: getLineNumber(sourceFile, node),
              },
            );
          }
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const calleeName = node.expression.text;

      if (bindings.aliases.has(calleeName)) {
        addUsage(
          usages,
          seenUsages,
          {
            method: `${packageName}()`,
            file: filePath,
            line: getLineNumber(sourceFile, node.expression),
          },
        );
      }

      const importedMember = bindings.namedImports.get(calleeName);
      if (importedMember) {
        addUsage(
          usages,
          seenUsages,
          {
            method: `${packageName}.${importedMember}`,
            file: filePath,
            line: getLineNumber(sourceFile, node.expression),
          },
        );
      }
    }
  });

  return usages;
}

function findImportBindings(
  sourceFile: ts.SourceFile,
  packageName: string,
  filePath: string,
  reExportMap: ReExportMap,
): ImportBindings {
  const bindings: ImportBindings = {
    aliases: new Set<string>(),
    namedImports: new Map<string, string>(),
  };

  visitNodes(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      const moduleText = getModuleSpecifierText(node);
      if (moduleText === packageName) {
        // Direct package import
        collectImportDeclarationBindings(node, bindings);
      } else if (moduleText?.startsWith(".")) {
        // Relative import — check if it's from a re-export file
        const resolvedPaths = resolveImportToAbsolutePaths(filePath, moduleText);
        for (const resolvedPath of resolvedPaths) {
          const reExported = reExportMap.get(resolvedPath);
          if (reExported) {
            collectReExportImportBindings(node, reExported, bindings);
            break;
          }
        }
      }
    }

    if (ts.isVariableStatement(node)) {
      collectRequireBindings(node, packageName, bindings);
      collectDynamicImportBindings(node, packageName, bindings);
    }
  });

  return bindings;
}

function collectImportDeclarationBindings(
  node: ts.ImportDeclaration,
  bindings: ImportBindings,
): void {
  const importClause = node.importClause;
  if (!importClause) {
    return;
  }

  if (importClause.name) {
    bindings.aliases.add(importClause.name.text);
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings) {
    return;
  }

  if (ts.isNamespaceImport(namedBindings)) {
    bindings.aliases.add(namedBindings.name.text);
    return;
  }

  for (const element of namedBindings.elements) {
    const importedName = element.propertyName?.text ?? element.name.text;
    bindings.namedImports.set(element.name.text, importedName);
  }
}

function collectRequireBindings(
  node: ts.VariableStatement,
  packageName: string,
  bindings: ImportBindings,
): void {
  for (const declaration of node.declarationList.declarations) {
    const requiredPackageName = getRequiredPackageName(declaration.initializer);
    if (requiredPackageName !== packageName) {
      continue;
    }

    if (ts.isIdentifier(declaration.name)) {
      bindings.aliases.add(declaration.name.text);
      continue;
    }

    if (!ts.isObjectBindingPattern(declaration.name)) {
      continue;
    }

    for (const element of declaration.name.elements) {
      if (!ts.isIdentifier(element.name)) {
        continue;
      }

      const importedName = getBindingElementImportedName(element);
      bindings.namedImports.set(element.name.text, importedName);
    }
  }
}

/**
 * Tracks dynamic import() assignments. Only handles the common case where the
 * import result is immediately assigned to a named variable or destructured binding.
 * If the import result is passed directly to a function without assignment, it
 * cannot be tracked — this is an accepted limitation.
 */
function collectDynamicImportBindings(
  node: ts.VariableStatement,
  packageName: string,
  bindings: ImportBindings,
): void {
  for (const declaration of node.declarationList.declarations) {
    const dynamicPackageName = getDynamicImportPackageName(declaration.initializer);
    if (dynamicPackageName !== packageName) {
      continue;
    }

    if (ts.isIdentifier(declaration.name)) {
      // const lib = await import('axios')  →  lib goes to aliases
      bindings.aliases.add(declaration.name.text);
      continue;
    }

    if (!ts.isObjectBindingPattern(declaration.name)) {
      continue;
    }

    // const { get, create } = await import('axios')
    for (const element of declaration.name.elements) {
      if (!ts.isIdentifier(element.name)) {
        continue;
      }

      const importedName = getBindingElementImportedName(element);
      bindings.namedImports.set(element.name.text, importedName);
    }
  }
}

function getDynamicImportPackageName(initializer: ts.Expression | undefined): string | null {
  if (!initializer) {
    return null;
  }

  let expression: ts.Expression = initializer;

  // Unwrap await: const lib = await import('axios')
  if (ts.isAwaitExpression(expression)) {
    expression = expression.expression;
  }

  // Check for import() call expression
  if (
    !ts.isCallExpression(expression) ||
    expression.expression.kind !== ts.SyntaxKind.ImportKeyword
  ) {
    return null;
  }

  if (expression.arguments.length !== 1) {
    return null;
  }

  const [firstArgument] = expression.arguments;
  return ts.isStringLiteral(firstArgument) ? firstArgument.text : null;
}

/**
 * Collects import bindings from a file that re-exports package members.
 * Only imports whose names appear in the re-export map are treated as
 * package imports — other imports from the same file are ignored.
 */
function collectReExportImportBindings(
  node: ts.ImportDeclaration,
  reExported: ReExportedBindings,
  bindings: ImportBindings,
): void {
  const importClause = node.importClause;
  if (!importClause) {
    return;
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) {
    return;
  }

  for (const element of namedBindings.elements) {
    // importedName = the name used in the re-export file (what we look up in reExported)
    // localName    = the name used in the current file (what we store in bindings)
    const importedName = element.propertyName?.text ?? element.name.text;
    const localName = element.name.text;

    if (reExported.defaults.has(importedName)) {
      // e.g. export { default as axios } from 'pkg' → import { axios } from './http'
      // axios acts as the package object itself → alias
      bindings.aliases.add(localName);
    } else if (reExported.named.has(importedName) || reExported.wildcard) {
      // Named re-export or wildcard: treat as named import from the package
      bindings.namedImports.set(localName, importedName);
    }
  }
}

/**
 * Pre-scans all project files to find files that re-export members from
 * the target package. Returns a map from absolute file path to the set of
 * names re-exported from that package.
 *
 * Only goes one level deep — re-export chains are not followed.
 */
async function buildReExportMap(packageName: string, files: string[]): Promise<ReExportMap> {
  const reExportMap: ReExportMap = new Map();

  for (const filePath of files) {
    const sourceText = await readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );

    const reExported: ReExportedBindings = {
      named: new Set(),
      defaults: new Set(),
      wildcard: false,
    };

    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement)) {
        continue;
      }

      const moduleText =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;

      if (moduleText !== packageName) {
        continue;
      }

      if (!statement.exportClause) {
        // export * from 'packageName'
        reExported.wildcard = true;
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          // element.propertyName is the original name; element.name is the exported name
          const originalName = element.propertyName?.text ?? element.name.text;
          const exportedName = element.name.text;

          if (originalName === "default") {
            // export { default as axios } from 'packageName'
            reExported.defaults.add(exportedName);
          } else {
            reExported.named.add(exportedName);
          }
        }
      }
    }

    if (reExported.named.size > 0 || reExported.defaults.size > 0 || reExported.wildcard) {
      reExportMap.set(filePath, reExported);
    }
  }

  return reExportMap;
}

/**
 * Returns candidate absolute paths for a relative import specifier,
 * trying common TypeScript/JavaScript file extensions and index files.
 */
function resolveImportToAbsolutePaths(importingFilePath: string, importSpecifier: string): string[] {
  const dir = path.dirname(importingFilePath);
  const base = path.resolve(dir, importSpecifier);

  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.js"),
  ];
}

function getRequiredPackageName(initializer: ts.Expression | undefined): string | null {
  if (!initializer || !ts.isCallExpression(initializer)) {
    return null;
  }

  if (
    !ts.isIdentifier(initializer.expression) ||
    initializer.expression.text !== "require"
  ) {
    return null;
  }

  if (initializer.arguments.length !== 1) {
    return null;
  }

  const [firstArgument] = initializer.arguments;
  return ts.isStringLiteral(firstArgument) ? firstArgument.text : null;
}

function getBindingElementImportedName(element: ts.BindingElement): string {
  if (element.propertyName && ts.isIdentifier(element.propertyName)) {
    return element.propertyName.text;
  }

  if (ts.isIdentifier(element.name)) {
    return element.name.text;
  }

  return "";
}

function getModuleSpecifierText(node: ts.ImportDeclaration): string | null {
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
}

function getPropertyChain(node: ts.PropertyAccessExpression): string[] | null {
  const chain: string[] = [node.name.text];
  let currentExpression: ts.Expression = node.expression;

  while (ts.isPropertyAccessExpression(currentExpression)) {
    chain.unshift(currentExpression.name.text);
    currentExpression = currentExpression.expression;
  }

  if (!ts.isIdentifier(currentExpression)) {
    return null;
  }

  chain.unshift(currentExpression.text);
  return chain;
}

function isOutermostPropertyAccess(node: ts.PropertyAccessExpression): boolean {
  return !(
    ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
  );
}

function getLineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function addUsage(usages: Usage[], seenUsages: Set<string>, usage: Usage): void {
  const usageKey = `${usage.method}:${usage.file}:${usage.line}`;
  if (seenUsages.has(usageKey)) {
    return;
  }

  seenUsages.add(usageKey);
  usages.push(usage);
}

function visitNodes(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => visitNodes(child, visitor));
}

function isDepImpactFile(filePath: string): boolean {
  const normalizedFilePath = path.resolve(filePath);
  const relativeToToolRoot = path.relative(TOOL_ROOT, normalizedFilePath);

  return (
    relativeToToolRoot !== "" &&
    !relativeToToolRoot.startsWith("..") &&
    !path.isAbsolute(relativeToToolRoot)
  );
}
