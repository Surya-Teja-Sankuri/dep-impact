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

  for (const filePath of relevantFiles) {
    const fileUsages = await scanFile(packageName, filePath);

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

async function scanFile(packageName: string, filePath: string): Promise<Usage[]> {
  const sourceText = await readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const bindings = findImportBindings(sourceFile, packageName);

  if (bindings.aliases.size === 0 && bindings.namedImports.size === 0) {
    return [];
  }

  const usages: Usage[] = [];
  const seenUsages = new Set<string>();

  visitNodes(sourceFile, (node) => {
    if (ts.isPropertyAccessExpression(node) && isOutermostPropertyAccess(node)) {
      const chain = getPropertyChain(node);
      if (chain && bindings.aliases.has(chain[0]) && chain.length > 1) {
        addUsage(
          usages,
          seenUsages,
          {
            method: `${packageName}.${chain.slice(1).join(".")}`,
            file: filePath,
            line: getLineNumber(sourceFile, node),
          },
        );
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
): ImportBindings {
  const bindings: ImportBindings = {
    aliases: new Set<string>(),
    namedImports: new Map<string, string>(),
  };

  visitNodes(sourceFile, (node) => {
    if (ts.isImportDeclaration(node) && getModuleSpecifierText(node) === packageName) {
      collectImportDeclarationBindings(node, bindings);
    }

    if (ts.isVariableStatement(node)) {
      collectRequireBindings(node, packageName, bindings);
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
