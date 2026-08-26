import { readFile } from "node:fs/promises";
import ts from "typescript";

export type BreakingChange = {
  identifier: string;
  description: string;
  severity: "breaking" | "changed" | "deprecated";
};

export type DiffResult = {
  breakingChanges: BreakingChange[];
  totalExportsOld: number;
  totalExportsNew: number;
  diffStrategy: "type-diff";
};

export type ExportedMember = {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "method";
  signature: string;
  parameters?: string[];
};

/**
 * Diffs exported API surfaces across two sets of declaration files and returns
 * the breaking or changed members between versions.
 */
export async function diffTypeDefinitions(
  oldDtsFiles: string[],
  newDtsFiles: string[],
  packageName: string,
): Promise<DiffResult> {
  const oldExports = await extractExports(oldDtsFiles);
  const newExports = await extractExports(newDtsFiles);
  const breakingChanges: BreakingChange[] = [];

  for (const [name, oldMember] of oldExports.entries()) {
    const newMember = newExports.get(name);

    if (!newMember) {
      breakingChanges.push({
        identifier: qualifyIdentifier(packageName, name),
        description: `${name} was removed`,
        severity: "breaking",
      });
      continue;
    }

    if (oldMember.signature === newMember.signature) {
      continue;
    }

    breakingChanges.push({
      identifier: qualifyIdentifier(packageName, name),
      description: `${name} signature changed: was ${oldMember.signature}, now ${newMember.signature}`,
      severity: getSignatureChangeSeverity(oldMember, newMember),
    });
  }

  return {
    breakingChanges,
    totalExportsOld: oldExports.size,
    totalExportsNew: newExports.size,
    diffStrategy: "type-diff",
  };
}

/**
 * Extracts the public API surface of a set of declaration files into a map
 * keyed by exported name. Three export shapes are recognized:
 *   1. Inline modifier   — `export function foo() {}`, `export interface X {}`
 *   2. Bare re-export    — `export { foo, bar as baz };` (no module specifier)
 *   3. Export assignment — `export = foo;` (CommonJS-style .d.ts), including
 *      the common `declare namespace foo { export interface Result {} }`
 *      merge pattern, whose exported namespace members are flattened to
 *      dotted names (e.g. "foo.Result").
 */
async function extractExports(dtsFiles: string[]): Promise<Map<string, ExportedMember>> {
  const exportsMap = new Map<string, ExportedMember>();

  for (const filePath of dtsFiles) {
    const sourceText = await readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );

    const bareReExportNames = collectBareReExportNames(sourceFile);
    const exportAssignmentTarget = findExportAssignmentTarget(sourceFile);
    const namedDeclLookup = buildNamedDeclLookup(sourceFile.statements);

    for (const statement of sourceFile.statements) {
      if (
        ts.isModuleDeclaration(statement) &&
        hasExportModifier(statement) &&
        ts.isIdentifier(statement.name)
      ) {
        flattenNamespaceMembers(statement.name.text, statement, sourceFile, exportsMap);
        continue;
      }

      const declaredName = getStatementDeclaredName(statement);
      const bareExportName =
        declaredName !== null ? bareReExportNames.get(declaredName) : undefined;

      if (!hasExportModifier(statement) && bareExportName === undefined) {
        continue;
      }

      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const exportName = bareExportName ?? statement.name.text;
        exportsMap.set(exportName, {
          name: exportName,
          kind: "function",
          signature: getCallableSignature(statement, sourceFile),
          parameters: statement.parameters.map(getParameterName),
        });
        continue;
      }

      if (ts.isClassDeclaration(statement) && statement.name) {
        const exportName = bareExportName ?? statement.name.text;
        exportsMap.set(exportName, {
          name: exportName,
          kind: "class",
          signature: stringifyClassSignature(statement, sourceFile),
        });
        addClassMethods(exportName, statement, sourceFile, exportsMap);
        continue;
      }

      if (ts.isInterfaceDeclaration(statement)) {
        const exportName = bareExportName ?? statement.name.text;
        exportsMap.set(exportName, {
          name: exportName,
          kind: "interface",
          signature: statement.members
            .map((member) => stringifyNode(member, sourceFile))
            .join("; "),
        });
        // Also decompose members (including inherited ones) into dotted
        // names, e.g. "AxiosStatic.create" — many real .d.ts files model
        // an entire callable/property surface as one interface, and a
        // whole-interface signature blob is too coarse to usefully diff.
        addInterfaceMembers(exportName, statement.name.text, namedDeclLookup, sourceFile, exportsMap);
        continue;
      }

      if (ts.isTypeAliasDeclaration(statement)) {
        const exportName = bareExportName ?? statement.name.text;
        exportsMap.set(exportName, {
          name: exportName,
          kind: "type",
          signature: stringifyNode(statement.type, sourceFile),
        });
        continue;
      }

      if (ts.isVariableStatement(statement)) {
        const statementIsExported = hasExportModifier(statement);

        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) {
            continue;
          }

          const declarationBareExportName = bareReExportNames.get(declaration.name.text);
          if (!statementIsExported && declarationBareExportName === undefined) {
            continue;
          }

          const exportName = declarationBareExportName ?? declaration.name.text;
          exportsMap.set(exportName, {
            name: exportName,
            kind: "variable",
            signature: declaration.type
              ? stringifyNode(declaration.type, sourceFile)
              : "unknown",
          });
        }
      }
    }

    if (exportAssignmentTarget) {
      addExportAssignmentTarget(exportAssignmentTarget, sourceFile, exportsMap);
    }

    // Common pattern: `declare const axios: AxiosStatic; export default axios;`
    // The default export's real shape is the referenced interface/class, so
    // flatten its members onto plain top-level names — matching how usage
    // like `axios.create()` is recorded (as "axios.create", not
    // "axios.AxiosStatic.create") lets the scorer actually connect the two.
    const defaultExportTarget = findDefaultExportTarget(sourceFile);
    if (defaultExportTarget) {
      const typeName = findDeclaredConstTypeName(defaultExportTarget, sourceFile);
      if (typeName) {
        const members = collectInterfaceMembers(typeName, namedDeclLookup, sourceFile, new Set());
        for (const [name, member] of members) {
          exportsMap.set(name, member);
        }
      }
    }
  }

  return exportsMap;
}

function buildNamedDeclLookup(
  statements: readonly ts.Statement[],
): Map<string, ts.InterfaceDeclaration | ts.ClassDeclaration> {
  const lookup = new Map<string, ts.InterfaceDeclaration | ts.ClassDeclaration>();

  for (const statement of statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      lookup.set(statement.name.text, statement);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      lookup.set(statement.name.text, statement);
    }
  }

  return lookup;
}

function getHeritageTypeNames(node: ts.InterfaceDeclaration | ts.ClassDeclaration): string[] {
  const names: string[] = [];

  for (const clause of node.heritageClauses ?? []) {
    for (const type of clause.types) {
      if (ts.isIdentifier(type.expression)) {
        names.push(type.expression.text);
      }
    }
  }

  return names;
}

/**
 * Collects the named members of an interface or class, including those
 * inherited via `extends` (a child's own member overrides an inherited one
 * of the same name). Only named property/method members are collected —
 * bare call signatures and index signatures have no name to key on.
 */
function collectInterfaceMembers(
  typeName: string,
  lookup: Map<string, ts.InterfaceDeclaration | ts.ClassDeclaration>,
  sourceFile: ts.SourceFile,
  visited: Set<string>,
): Map<string, ExportedMember> {
  const members = new Map<string, ExportedMember>();

  if (visited.has(typeName)) {
    return members;
  }
  visited.add(typeName);

  const decl = lookup.get(typeName);
  if (!decl) {
    return members;
  }

  for (const parentName of getHeritageTypeNames(decl)) {
    const parentMembers = collectInterfaceMembers(parentName, lookup, sourceFile, visited);
    for (const [name, member] of parentMembers) {
      members.set(name, member);
    }
  }

  if (ts.isInterfaceDeclaration(decl)) {
    for (const member of decl.members) {
      if (!member.name || !ts.isIdentifier(member.name)) {
        continue;
      }

      if (ts.isMethodSignature(member)) {
        members.set(member.name.text, {
          name: member.name.text,
          kind: "method",
          signature: getCallableSignature(member, sourceFile),
          parameters: member.parameters.map(getParameterName),
        });
      } else if (ts.isPropertySignature(member)) {
        members.set(member.name.text, {
          name: member.name.text,
          kind: "variable",
          signature: member.type ? stringifyNode(member.type, sourceFile) : "unknown",
        });
      }
    }
  } else {
    for (const member of decl.members) {
      if (
        !ts.isMethodDeclaration(member) ||
        !member.name ||
        !ts.isIdentifier(member.name) ||
        hasPrivateLikeModifier(member)
      ) {
        continue;
      }

      members.set(member.name.text, {
        name: member.name.text,
        kind: "method",
        signature: getCallableSignature(member, sourceFile),
        parameters: member.parameters.map(getParameterName),
      });
    }
  }

  return members;
}

function addInterfaceMembers(
  qualifiedPrefix: string,
  typeName: string,
  lookup: Map<string, ts.InterfaceDeclaration | ts.ClassDeclaration>,
  sourceFile: ts.SourceFile,
  exportsMap: Map<string, ExportedMember>,
): void {
  const members = collectInterfaceMembers(typeName, lookup, sourceFile, new Set());

  for (const [name, member] of members) {
    const qualifiedName = `${qualifiedPrefix}.${name}`;
    exportsMap.set(qualifiedName, { ...member, name: qualifiedName });
  }
}

/**
 * Finds `export default X;` (as opposed to `export = X;`) and returns the
 * identifier text of X, or null if there's no default export or it isn't a
 * plain identifier.
 */
function findDefaultExportTarget(sourceFile: ts.SourceFile): string | null {
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      ts.isIdentifier(statement.expression)
    ) {
      return statement.expression.text;
    }
  }

  return null;
}

/**
 * Finds `declare const <name>: <TypeName>;` and returns TypeName, or null if
 * no such declaration exists or its type isn't a plain type reference.
 */
function findDeclaredConstTypeName(name: string, sourceFile: ts.SourceFile): string | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.type &&
        ts.isTypeReferenceNode(declaration.type) &&
        ts.isIdentifier(declaration.type.typeName)
      ) {
        return declaration.type.typeName.text;
      }
    }
  }

  return null;
}

/**
 * Finds a bare `export { a, b as c };` declaration (no module specifier) and
 * returns a map from each member's original declared name to its exported
 * (possibly renamed) name.
 */
function collectBareReExportNames(sourceFile: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier) {
      continue;
    }

    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      continue;
    }

    for (const element of statement.exportClause.elements) {
      const originalName = element.propertyName?.text ?? element.name.text;
      names.set(originalName, element.name.text);
    }
  }

  return names;
}

/**
 * Finds `export = X;` and returns the identifier text of X, or null if the
 * file has no export assignment or assigns something other than a plain
 * identifier (e.g. an object literal), which this differ does not resolve.
 */
function findExportAssignmentTarget(sourceFile: ts.SourceFile): string | null {
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportAssignment(statement) &&
      statement.isExportEquals &&
      ts.isIdentifier(statement.expression)
    ) {
      return statement.expression.text;
    }
  }

  return null;
}

/**
 * Resolves `export = targetName` by finding every top-level declaration named
 * targetName (there may be more than one due to declaration merging, e.g. a
 * function merged with a same-named namespace) and adding it to the exports
 * map under its plain name.
 */
function addExportAssignmentTarget(
  targetName: string,
  sourceFile: ts.SourceFile,
  exportsMap: Map<string, ExportedMember>,
): void {
  for (const statement of sourceFile.statements) {
    if (
      ts.isModuleDeclaration(statement) &&
      ts.isIdentifier(statement.name) &&
      statement.name.text === targetName
    ) {
      flattenNamespaceMembers(targetName, statement, sourceFile, exportsMap);
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name?.text === targetName) {
      exportsMap.set(targetName, {
        name: targetName,
        kind: "function",
        signature: getCallableSignature(statement, sourceFile),
        parameters: statement.parameters.map(getParameterName),
      });
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name?.text === targetName) {
      exportsMap.set(targetName, {
        name: targetName,
        kind: "class",
        signature: stringifyClassSignature(statement, sourceFile),
      });
      addClassMethods(targetName, statement, sourceFile, exportsMap);
      continue;
    }

    if (ts.isInterfaceDeclaration(statement) && statement.name.text === targetName) {
      exportsMap.set(targetName, {
        name: targetName,
        kind: "interface",
        signature: statement.members
          .map((member) => stringifyNode(member, sourceFile))
          .join("; "),
      });
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === targetName) {
      exportsMap.set(targetName, {
        name: targetName,
        kind: "type",
        signature: stringifyNode(statement.type, sourceFile),
      });
    }
  }
}

/**
 * Flattens the exported members of an ambient namespace/module block into
 * the exports map under dotted names (e.g. "foo.Result"). Only members that
 * carry their own `export` modifier inside the namespace body are visible
 * outside it, matching TypeScript's ambient namespace semantics.
 */
function flattenNamespaceMembers(
  namespaceName: string,
  moduleDecl: ts.ModuleDeclaration,
  sourceFile: ts.SourceFile,
  exportsMap: Map<string, ExportedMember>,
): void {
  const body = moduleDecl.body;
  if (!body || !ts.isModuleBlock(body)) {
    return;
  }

  for (const statement of body.statements) {
    if (!hasExportModifier(statement)) {
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const qualifiedName = `${namespaceName}.${statement.name.text}`;
      exportsMap.set(qualifiedName, {
        name: qualifiedName,
        kind: "function",
        signature: getCallableSignature(statement, sourceFile),
        parameters: statement.parameters.map(getParameterName),
      });
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const qualifiedName = `${namespaceName}.${statement.name.text}`;
      exportsMap.set(qualifiedName, {
        name: qualifiedName,
        kind: "class",
        signature: stringifyClassSignature(statement, sourceFile),
      });
      addClassMethods(qualifiedName, statement, sourceFile, exportsMap);
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      const qualifiedName = `${namespaceName}.${statement.name.text}`;
      exportsMap.set(qualifiedName, {
        name: qualifiedName,
        kind: "interface",
        signature: statement.members
          .map((member) => stringifyNode(member, sourceFile))
          .join("; "),
      });
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      const qualifiedName = `${namespaceName}.${statement.name.text}`;
      exportsMap.set(qualifiedName, {
        name: qualifiedName,
        kind: "type",
        signature: stringifyNode(statement.type, sourceFile),
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          continue;
        }

        const qualifiedName = `${namespaceName}.${declaration.name.text}`;
        exportsMap.set(qualifiedName, {
          name: qualifiedName,
          kind: "variable",
          signature: declaration.type
            ? stringifyNode(declaration.type, sourceFile)
            : "unknown",
        });
      }
      continue;
    }

    if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      flattenNamespaceMembers(
        `${namespaceName}.${statement.name.text}`,
        statement,
        sourceFile,
        exportsMap,
      );
    }
  }
}

function addClassMethods(
  className: string,
  classNode: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  exportsMap: Map<string, ExportedMember>,
): void {
  for (const member of classNode.members) {
    if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) {
      continue;
    }

    if (hasPrivateLikeModifier(member)) {
      continue;
    }

    const methodName = `${className}.${member.name.text}`;
    exportsMap.set(methodName, {
      name: methodName,
      kind: "method",
      signature: getCallableSignature(member, sourceFile),
      parameters: member.parameters.map(getParameterName),
    });
  }
}

/**
 * Returns the name a top-level statement declares, if any — used to check
 * whether a statement (regardless of its own export modifier) is the target
 * of a bare `export { name };` re-export.
 */
function getStatementDeclaredName(statement: ts.Statement): string | null {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name?.text ?? null;
  }

  if (ts.isClassDeclaration(statement)) {
    return statement.name?.text ?? null;
  }

  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
    return statement.name.text;
  }

  return null;
}

function stringifyNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, " ").trim();
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (modifiers ?? []).some(
    (modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function hasPrivateLikeModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (modifiers ?? []).some((modifier: ts.Modifier) =>
    modifier.kind === ts.SyntaxKind.PrivateKeyword ||
    modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

function getCallableSignature(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.MethodSignature,
  sourceFile: ts.SourceFile,
): string {
  const parameterText = node.parameters
    .map((parameter) => stringifyNode(parameter, sourceFile))
    .join(", ");
  const returnType = node.type ? stringifyNode(node.type, sourceFile) : "void";

  return `(${parameterText}) => ${returnType}`;
}

function stringifyClassSignature(
  statement: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
): string {
  const heritage = statement.heritageClauses
    ?.map((clause) => stringifyNode(clause, sourceFile))
    .join(" ") ?? "";

  return heritage.trim() || "class";
}

function getParameterName(parameter: ts.ParameterDeclaration): string {
  const name = ts.isIdentifier(parameter.name)
    ? parameter.name.text
    : parameter.name.getText();

  const isOptional = Boolean(parameter.questionToken || parameter.initializer);
  const isRest = Boolean(parameter.dotDotDotToken);

  return `${isRest ? "..." : ""}${name}${isOptional ? "?" : ""}`;
}

function getSignatureChangeSeverity(
  oldMember: ExportedMember,
  newMember: ExportedMember,
): "breaking" | "changed" | "deprecated" {
  const oldParameters = oldMember.parameters ?? [];
  const newParameters = newMember.parameters ?? [];

  if (oldParameters.length > newParameters.length) {
    return "breaking";
  }

  if (countRequiredParameters(newParameters) > countRequiredParameters(oldParameters)) {
    return "breaking";
  }

  return "changed";
}

function countRequiredParameters(parameters: string[]): number {
  return parameters.filter(
    (parameter) => !parameter.endsWith("?") && !parameter.startsWith("..."),
  ).length;
}

function qualifyIdentifier(packageName: string, name: string): string {
  if (name.includes(".")) {
    return name;
  }

  return `${packageName}.${name}`;
}
