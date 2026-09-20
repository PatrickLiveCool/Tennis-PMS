// Read-only bootstrap evidence: SQL hashes from an exact Git ref or the running image.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
const migrationDirectory = 'packages/db/src/tennis/migrations';
const [mode, ref, ...extra] = process.argv.slice(2);
if (extra.length || (mode !== '--git' && mode !== '--image') || (mode === '--git' ? !ref || ref.startsWith('-') : ref)) {
  throw new Error('Use --git VERIFIED_REF locally, or --image inside the running container');
}
let paths;
let read;
if (mode === '--git') {
  const commit = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  paths = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', migrationDirectory], { encoding: 'utf8' })
    .trim().split('\n').map(path => path.slice(migrationDirectory.length + 1));
  read = name => execFileSync('git', ['show', `${commit}:${migrationDirectory}/${name}`]);
} else {
  paths = readdirSync(`/app/${migrationDirectory}`);
  read = name => readFileSync(`/app/${migrationDirectory}/${name}`);
}
if (!paths.length || paths.some(name => !/^[0-9]{3,}_[a-z0-9_]+\.sql$/.test(name))) {
  throw new Error('Unexpected or empty migration directory; verify baseline manually');
}
const baseline = paths.sort().map(name => ({ name, sha256: createHash('sha256').update(read(name)).digest('hex') }));
process.stdout.write(JSON.stringify(baseline, null, 2) + '\n');
