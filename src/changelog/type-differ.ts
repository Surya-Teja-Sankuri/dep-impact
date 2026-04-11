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

    for (const statement of sourceFile.statements) {
      if (!hasExportModifier(statement)) {
        continue;
      }

      if (ts.isFunctionDeclaration(statement) && statement.name) {
        exportsMap.set(statement.name.text, {
          name: statement.name.text,
          kind: "function",
          signature: getCallableSignature(statement, sourceFile),
          parameters: statement.parameters.map(getParameterName),
        });
        continue;
      }

      if (ts.isClassDeclaration(statement) && statement.name) {
        const className = statement.name.text;
        exportsMap.set(className, {
          name: className,
          kind: "class",
          signature: stringifyClassSignature(statement, sourceFile),
        });

        for (const member of statement.members) {
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

        continue;
      }

      if (ts.isInterfaceDeclaration(statement)) {
        exportsMap.set(statement.name.text, {
          name: statement.name.text,
          kind: "interface",
          signature: statement.members
            .map((member) => stringifyNode(member, sourceFile))
            .join("; "),
        });
        continue;
      }

      if (ts.isTypeAliasDeclaration(statement)) {
        exportsMap.set(statement.name.text, {
          name: statement.name.text,
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

          exportsMap.set(declaration.name.text, {
            name: declaration.name.text,
            kind: "variable",
            signature: declaration.type
              ? stringifyNode(declaration.type, sourceFile)
              : "unknown",
          });
        }
      }
    }
  }

  return exportsMap;
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
  node: ts.FunctionDeclaration | ts.MethodDeclaration,
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
  return parameters.filter((parameter) => !parameter.endsWith("?")).length;
}

function qualifyIdentifier(packageName: string, name: string): string {
  if (name.includes(".")) {
    return name;
  }

  return `${packageName}.${name}`;
}
