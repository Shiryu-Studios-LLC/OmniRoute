import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const forbiddenBuiltins = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")])
);
const forbiddenNativePackages = new Set([
  "better-sqlite3",
  "keytar",
  "node-machine-id",
  "onnxruntime-node",
  "sharp",
  "sqlite-vec",
  "tls-client-node",
  "wreq-js",
]);

function moduleSpecifiers(sourceFile) {
  const specifiers = [];
  const dynamicLoads = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        specifiers.push(node.arguments[0].text);
      } else {
        dynamicLoads.push(
          node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import()" : "require()"
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { specifiers, dynamicLoads };
}

function resolveLocal(specifier, fromFile) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs"].map((ext) => base + ext),
    ...["index.ts", "index.tsx", "index.js", "index.mjs"].map((name) => path.join(base, name)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function inspect(file, repoRoot, visited, violations) {
  if (visited.has(file)) return;
  visited.add(file);
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

  function findProcessReferences(node) {
    if (ts.isIdentifier(node) && node.text === "process") {
      const parent = node.parent;
      const isImportBinding = ts.isImportClause(parent) || ts.isImportSpecifier(parent);
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) &&
          parent.name === node &&
          !(ts.isIdentifier(parent.expression) && parent.expression.text === "globalThis")) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isImportBinding && !isPropertyName) {
        violations.push(path.relative(repoRoot, file) + " -> process global");
      }
    }
    ts.forEachChild(node, findProcessReferences);
  }
  findProcessReferences(sourceFile);

  const { specifiers, dynamicLoads } = moduleSpecifiers(sourceFile);
  for (const load of dynamicLoads) {
    violations.push(path.relative(repoRoot, file) + " -> non-literal " + load);
  }
  for (const specifier of specifiers) {
    const normalized = specifier.replace(/^node:/, "");
    const packageName = normalized.startsWith("@")
      ? normalized.split("/").slice(0, 2).join("/")
      : normalized.split("/")[0];
    if (
      specifier.endsWith(".node") ||
      forbiddenBuiltins.has(specifier) ||
      forbiddenBuiltins.has(normalized)
    ) {
      violations.push(path.relative(repoRoot, file) + " -> " + specifier);
      continue;
    }
    if (forbiddenNativePackages.has(packageName)) {
      violations.push(path.relative(repoRoot, file) + " -> native package " + packageName);
      continue;
    }
    const resolved = resolveLocal(specifier, file);
    if (resolved) inspect(resolved, repoRoot, visited, violations);
  }
}

export function analyzeWorkerGraph(repoRoot, entry) {
  const visited = new Set();
  const violations = [];
  if (!fs.existsSync(entry)) {
    violations.push("Missing Cloudflare entry: " + path.relative(repoRoot, entry));
    return { files: [], violations };
  }
  inspect(entry, repoRoot, visited, violations);
  const files = [...visited].map((file) => ({ file, bytes: fs.statSync(file).size }));
  return { files, violations: [...new Set(violations)] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const entry = path.join(repoRoot, "cloudflare/worker.ts");
  const { files, violations } = analyzeWorkerGraph(repoRoot, entry);
  if (violations.length) {
    console.error("Cloudflare Worker production graph contains Node-only dependencies:");
    for (const violation of violations) console.error("- " + violation);
    process.exit(1);
  }

  const sourceBytes = files.reduce((sum, item) => sum + item.bytes, 0);
  console.log(
    `Cloudflare Worker graph OK: ${files.length} reachable source files, ${sourceBytes} source bytes.`
  );
  for (const item of files) {
    console.log("  " + path.relative(repoRoot, item.file) + " (" + item.bytes + " bytes)");
  }
}
