import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("standard release runtime", () => {
  it("ships a separately invoked migration tool without demo seed or housing migrations", () => {
    const temporary = mkdtempSync(join(tmpdir(), "tennis-runtime-test-"));
    const source = join(temporary, "source");
    const output = join(temporary, "runtime");
    try {
      for (const tree of ["apps/api/src", "packages/contracts/src", "packages/domain/src", "packages/db/src/tennis/migrations", "scripts/tennis", "packages/db/catalog", "apps/web/dist-tennis"])
        mkdirSync(join(source, tree), { recursive: true });
      for (const file of ["package.json", "package-lock.json", "apps/api/package.json", "apps/web/package.json", "packages/contracts/package.json", "packages/domain/package.json", "packages/db/package.json", "scripts/tennis/release-migrate.mts", "scripts/tennis/runtime-config.mts", "packages/db/src/tennis/migrate.ts", "packages/db/src/tennis/assistant-question-records.ts", "packages/db/src/tennis/assistant-question-redaction.ts"]) {
        mkdirSync(dirname(join(source, file)), { recursive: true });
        cpSync(resolve(file), join(source, file));
      }
      const migrations = "packages/db/src/tennis/migrations";
      cpSync(resolve(migrations), join(source, migrations), { recursive: true });
      for (const file of ["scripts/tennis/cloud-demo-init.mts", "scripts/tennis/cloud-demo-data.ts", "packages/db/src/seed.ts", "packages/db/src/migrate.ts"])
        writeFileSync(join(source, file), 'throw new Error("seed or housing migration must not ship");');
      execFileSync(process.execPath, [resolve("scripts/build-runtime.mjs"), "--source-root", source, "--output", output]);
      expect(existsSync(join(output, "packages/db/src/tennis/migrate.js"))).toBe(true);
      const sqlFiles = readdirSync(resolve(migrations)).sort();
      expect(readdirSync(join(output, migrations)).sort()).toEqual(sqlFiles);
      for (const file of sqlFiles)
        expect(readFileSync(join(output, migrations, file))).toEqual(readFileSync(resolve(migrations, file)));
      for (const file of ["scripts/tennis/cloud-demo-init.mjs", "scripts/tennis/cloud-demo-data.js", "packages/db/src/seed.js", "packages/db/src/migrate.js"])
        expect(existsSync(join(output, file))).toBe(false);
      symlinkSync(resolve("node_modules"), join(output, "node_modules"), "dir");
      const imported = spawnSync(process.execPath, ["--input-type=module", "-e",
        "const records = await import('./packages/db/src/tennis/assistant-question-records.js'); if (!records.questionToolNames.has('get_work_context')) process.exit(1);"],
        { cwd: output, encoding: "utf8" });
      expect(imported.status, imported.stderr).toBe(0);
      const command = join(output, "scripts/tennis/release-migrate.mjs");
      for (const args of [[], ["--apply", "extra"]]) {
        const result = spawnSync(process.execPath, [command, ...args], { encoding: "utf8" });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("explicit administrator invocation");
      }
      for (const databaseUrl of [
        "postgres://tennis_demo:synthetic-secret@127.0.0.1/housing",
        "postgres://housing:synthetic-secret@127.0.0.1/tennis_demo",
      ]) {
        const result = spawnSync(process.execPath, [command, "--apply"], {
          encoding: "utf8", env: { ...process.env, TENNIS_MIGRATION_DATABASE_URL: databaseUrl },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("independent tennis_demo database");
        expect(result.stderr).not.toContain("synthetic-secret");
      }
      expect(JSON.parse(readFileSync(join(output, "package.json"), "utf8")).scripts).toEqual({ start: "node scripts/tennis/server-entry.mjs" });
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});
