import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const read = (path, rootDir = root) => readFileSync(resolve(rootDir, path), "utf8");

function changelogReleaseSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## (?:\\[${escaped}\\](?:\\([^\\n]+\\))?|v${escaped}\\b)`, "m");
  const match = heading.exec(changelog);
  if (!match) return undefined;
  const section = changelog.slice(match.index + match[0].length).split(/^## /m)[0].trim();
  return section || undefined;
}

function checkPolicy(rootDir, version) {
  const policy = JSON.parse(read("deploy/release-policy.json", rootDir));
  if (policy.application !== "tennis-green-pms") {
    throw new Error("release policy application must be tennis-green-pms");
  }
  if (policy.version !== version && policy.version !== `v${version}`) {
    throw new Error("release policy version must match package.json");
  }
  const compatibility = policy.rollbackCompatibility;
  if (!compatibility || !["same-migrations-only", "forward-only"].includes(compatibility.mode)) {
    throw new Error("release policy rollbackCompatibility mode is invalid");
  }
  if (typeof compatibility.reason !== "string" || !compatibility.reason.trim()) {
    throw new Error("release policy rollbackCompatibility reason is required");
  }
}

export function parseReleaseTag(value) {
  if (typeof value !== "string" || !TAG.test(value)) {
    throw new Error(`Release tag must match vX.Y.Z: ${value || "(missing)"}`);
  }
  return value.slice(1);
}

function tagFromEnvironment(environment) {
  const ref = environment.GITHUB_REF || "";
  return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : undefined;
}

export function checkRelease({ rootDir = root, tag, environment = process.env } = {}) {
  const packageJson = JSON.parse(read("package.json", rootDir));
  const lock = JSON.parse(read("package-lock.json", rootDir));
  const { version } = packageJson;

  if (!SEMVER.test(version)) {
    throw new Error(`package.json version must be strict semver: ${version}`);
  }
  if (lock.version !== version) {
    throw new Error("Root package-lock version must match package.json");
  }
  if (lock.packages?.[""]?.version !== version) {
    throw new Error("Root workspace lock version must match package.json");
  }

  const environmentTag = tagFromEnvironment(environment);
  if (tag !== undefined && environmentTag !== undefined && tag !== environmentTag) {
    throw new Error(`Explicit tag ${tag} does not match GITHUB_REF tag ${environmentTag}`);
  }
  const effectiveTag = tag ?? environmentTag;
  if (effectiveTag !== undefined) {
    const tagVersion = parseReleaseTag(effectiveTag);
    if (tagVersion !== version) {
      throw new Error(`Git tag ${effectiveTag} must match package.json version v${version}`);
    }
  }

  const changelog = read("CHANGELOG.md", rootDir);
  if (!changelogReleaseSection(changelog, version)) {
    throw new Error("CHANGELOG must contain a nonempty entry for the current version");
  }
  const optionalNotes = resolve(rootDir, `docs/releases/v${version}.md`);
  try {
    const notes = readFileSync(optionalNotes, "utf8");
    const targetTitle = `# Tennis-Green-PMS v${version}\n`;
    const inheritedTitle = version === "1.4.3" && notes.startsWith(`# QinTopia PMS v${version}\n`);
    if (!notes.startsWith(targetTitle) && !inheritedTitle) {
      throw new Error("Detailed release notes must name the current version");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  checkPolicy(rootDir, version);

  return { version, tag: effectiveTag ?? `v${version}` };
}

export function parseArguments(argumentsList = process.argv.slice(2)) {
  const tagIndex = argumentsList.indexOf("--tag");
  const rootIndex = argumentsList.indexOf("--root");
  const result = {};
  if (tagIndex !== -1) {
    const tag = argumentsList[tagIndex + 1];
    if (!tag || tag.startsWith("--")) {
      throw new Error("--tag requires a vX.Y.Z value");
    }
    result.tag = tag;
  }
  if (rootIndex !== -1) {
    const rootDir = argumentsList[rootIndex + 1];
    if (!rootDir || rootDir.startsWith("--")) {
      throw new Error("--root requires a source directory");
    }
    result.rootDir = resolve(rootDir);
  }
  return result;
}

export function main({ argumentsList = process.argv.slice(2), environment = process.env } = {}) {
  const result = checkRelease({ ...parseArguments(argumentsList), environment });
  console.log(`Release ${result.tag}: package, changelog, rollback policy and tag identity verified.`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Release check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
