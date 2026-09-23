import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { transform } from "esbuild";

const runtimeTrees = [
  ["apps/api/src", "apps/api/src"],
  ["packages/contracts/src", "packages/contracts/src"],
  ["packages/domain/src", "packages/domain/src"],
  ["packages/db/src", "packages/db/src"],
  ["scripts/tennis", "scripts/tennis"]
];
const excludedRuntimeFiles = new Set(["migrate.ts", "ready.ts", "reset.ts", "seed.ts"]);
const sourceFilePattern = /\.(?:ts|tsx|mts)$/u;
const testFilePattern = /(?:\.test|\.spec)\.(?:ts|tsx)$/u;

function parseOptions() {
  const { values } = parseArgs({
    options: {
      output: { type: "string", default: "runtime" },
      "demo-tools": { type: "boolean", default: false },
      "source-root": { type: "string", default: process.cwd() }
    },
    allowPositionals: false
  });
  return {
    root: resolve(values["source-root"]),
    output: resolve(values.output),
    demoTools: values["demo-tools"]
  };
}

function assertOutputIsSeparate(root, output) {
  if (root === output) throw new Error("runtime output must be separate from the source root");
}

function rewriteTypeScriptSpecifiers(code) {
  return code.replace(/(\b(?:from|import)\s*(?:\(\s*)?)(["'])([^"']+)\.(mts|ts)\2/gu,
    (_match, prefix, quote, path, extension) => `${prefix}${quote}${path}.${extension === "mts" ? "mjs" : "js"}${quote}`);
}

function runtimePackageJson(packageJson, relativePath) {
  const value = JSON.parse(packageJson);
  delete value.devDependencies;

  if (relativePath === "package.json") {
    value.type = "module";
    value.scripts = { start: "node scripts/tennis/server-entry.mjs" };
  } else if (relativePath === "apps/api/package.json") {
    value.scripts = { start: "node src/main.js" };
  } else {
    delete value.scripts;
  }

  const rewriteExports = (entry) => {
    if (typeof entry === "string") return entry.replace(/\.ts$/u, ".js");
    if (Array.isArray(entry)) return entry.map(rewriteExports);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, rewriteExports(child)]));
    }
    return entry;
  };
  if (value.exports) value.exports = rewriteExports(value.exports);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function rewriteRuntimeJsonImports(source, packageVersion, sourcePath, root) {
  return source.replace(
    /^\s*import\s*\{\s*version(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*\}\s*from\s*(["'])([^"']+\/package\.json)\2;?\s*$/gmu,
    (match, alias, _quote, packagePath) => resolve(dirname(sourcePath), packagePath) === resolve(root, "package.json")
      ? `const ${alias ?? "version"} = ${JSON.stringify(packageVersion)};`
      : match
  );
}

async function writeRuntimePackageJson(root, output, relativePath) {
  const source = resolve(root, relativePath);
  const target = resolve(output, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, runtimePackageJson(await readFile(source, "utf8"), relativePath));
}

async function transformTree(root, output, sourceRelative, outputRelative, packageVersion, demoTools) {
  const sourceDirectory = resolve(root, sourceRelative);
  const outputDirectory = resolve(output, outputRelative);

  async function visit(sourceDirectoryPath, outputDirectoryPath) {
    await mkdir(outputDirectoryPath, { recursive: true });
    for (const entry of await readdir(sourceDirectoryPath, { withFileTypes: true })) {
      const sourcePath = resolve(sourceDirectoryPath, entry.name);
      const outputPath = resolve(outputDirectoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(sourcePath, outputPath);
        continue;
      }
      if (!entry.isFile() || !sourceFilePattern.test(entry.name) || testFilePattern.test(entry.name)) continue;
      if (sourceRelative === "scripts/tennis" && !new Set([
        "server-entry.mts", "runtime-config.mts", "release-migrate.mts",
        ...(demoTools ? ["database.mts", "cloud-demo-init.mts", "cloud-demo-data.ts"] : [])
      ]).has(entry.name)) continue;
      if (sourceRelative === "packages/db/src" && excludedRuntimeFiles.has(entry.name)
        && relative(sourceDirectory, sourcePath) !== "tennis/migrate.ts") continue;

      const extension = extname(entry.name);
      const source = rewriteRuntimeJsonImports(await readFile(sourcePath, "utf8"), packageVersion, sourcePath, root);
      const transformed = await transform(source, {
        format: "esm",
        loader: extension === ".tsx" ? "tsx" : "ts",
        sourcefile: relative(root, sourcePath),
        target: "node22",
        sourcemap: false
      });
      await writeFile(outputPath.replace(/\.(?:tsx?|mts)$/u, extension === ".mts" ? ".mjs" : ".js"), rewriteTypeScriptSpecifiers(transformed.code));
    }
  }

  await visit(sourceDirectory, outputDirectory);
}

async function main() {
  const { root, output, demoTools } = parseOptions();
  assertOutputIsSeparate(root, output);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

  for (const [sourceRelative, outputRelative] of runtimeTrees) {
    await transformTree(root, output, sourceRelative, outputRelative, packageJson.version, demoTools);
  }

  await cp(resolve(root, "packages/db/src/tennis/migrations"), resolve(output, "packages/db/src/tennis/migrations"), { recursive: true });
  await cp(resolve(root, "packages/db/catalog"), resolve(output, "packages/db/catalog"), { recursive: true });
  await cp(resolve(root, "apps/web/dist-tennis"), resolve(output, "apps/web/dist-tennis"), { recursive: true });
  await cp(resolve(root, "package-lock.json"), resolve(output, "package-lock.json"));

  for (const relativePath of [
    "package.json",
    "apps/api/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
    "packages/domain/package.json",
    "packages/db/package.json"
  ]) {
    await writeRuntimePackageJson(root, output, relativePath);
  }
}

await main();
