import path from "node:path";
import ts from "typescript";

export const supportedSource = (name: string) => /\.[cm]?[jt]sx?$/.test(name);
export type StaticImport = {
  targetPath: string;
  lineStart: number;
  lineEnd: number;
};
export type ImportLimitation = {
  specifier: string | null;
  lineStart: number;
  lineEnd: number;
  reason: string;
};

// Bounded syntactic resolution, not the target compiler's module loader. No
// tsconfig, package resolver, filesystem walk or target code execution.
export function staticImports(
  name: string,
  content: string,
  paths: Set<string>,
  onUnknown: (item: ImportLimitation) => void = () => {},
): StaticImport[] {
  if (!supportedSource(name)) return [];
  const ast = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true);
  const range = (node: ts.Node) => ({
    lineStart: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
    lineEnd:
      ast.getLineAndCharacterOfPosition(
        Math.max(node.getStart(ast), node.getEnd() - 1),
      ).line + 1,
  });
  const unknown = (node: ts.Node, specifier: string | null, reason: string) =>
    onUnknown({ ...range(node), specifier, reason });
  const imports: StaticImport[] = [];
  for (const node of ast.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier)
    )
      continue;
    const specifier = node.moduleSpecifier.text;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      unknown(node, specifier, "package/alias import resolution unsupported");
      continue;
    }
    const stem = path.posix.normalize(
      path.posix.join(path.posix.dirname(name), specifier),
    );
    if (
      stem === ".." ||
      stem.startsWith("../") ||
      path.posix.isAbsolute(stem)
    ) {
      unknown(node, specifier, "import outside approved Git tree");
      continue;
    }
    const candidates = paths.has(stem)
      ? [stem]
      : [
          ...new Set([
            ...[
              ".ts",
              ".tsx",
              ".js",
              ".jsx",
              ".mts",
              ".cts",
              ".mjs",
              ".cjs",
              "/index.ts",
              "/index.tsx",
              "/index.js",
              "/index.jsx",
            ].map((ext) => stem + ext),
            ...(stem.endsWith(".js")
              ? [stem.slice(0, -3) + ".ts", stem.slice(0, -3) + ".tsx"]
              : []),
            ...(stem.endsWith(".mjs") ? [stem.slice(0, -4) + ".mts"] : []),
            ...(stem.endsWith(".cjs") ? [stem.slice(0, -4) + ".cts"] : []),
          ]),
        ].filter((p) => paths.has(p));
    // Ambiguous conventions stay unknown instead of picking the first path.
    if (candidates.length !== 1 || !supportedSource(candidates[0])) {
      unknown(
        node,
        specifier,
        candidates.length > 1
          ? "ambiguous static import target"
          : candidates.length
            ? "unsupported static target language"
            : "static import target missing from Git tree",
      );
      continue;
    }
    imports.push({ targetPath: candidates[0], ...range(node) });
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      unknown(
        node,
        argument && ts.isStringLiteral(argument) ? argument.text : null,
        node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? "dynamic import resolution unsupported"
          : "require resolution unsupported",
      );
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      unknown(
        node,
        ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : null,
        "re-export resolution unsupported",
      );
    } else if (ts.isImportEqualsDeclaration(node)) {
      unknown(node, null, "import-equals resolution unsupported");
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return imports;
}
