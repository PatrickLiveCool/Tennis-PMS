import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import tennisViteConfig from "../../apps/web/vite.tennis.config";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const deploymentConfig = JSON.parse(readFileSync(resolve(repositoryRoot, "vercel.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));

describe("Vercel tennis build configuration", () => {
  it("publishes the actual tennis Vite output relative to the repository root", () => {
    expect(tennisViteConfig.root).toBeTypeOf("string");
    expect(tennisViteConfig.build?.outDir).toBeTypeOf("string");
    const outputDirectory = relative(repositoryRoot, resolve(
      tennisViteConfig.root!, tennisViteConfig.build!.outDir!,
    )).replaceAll("\\", "/");
    expect(deploymentConfig.outputDirectory).toBe(outputDirectory);
    expect(deploymentConfig.outputDirectory).toBe("apps/web/dist-tennis");
  });

  it("keeps the release check and tennis-only build entry", () => {
    expect(deploymentConfig.buildCommand).toBe("npm run build");
    expect(manifest.scripts.build).toContain("npm run release:check");
    expect(manifest.scripts.build).toContain("--config apps/web/vite.tennis.config.ts");
    expect(tennisViteConfig.build?.rollupOptions?.input).toBe(
      resolve(repositoryRoot, "apps/web/tennis.html"),
    );
  });
});
