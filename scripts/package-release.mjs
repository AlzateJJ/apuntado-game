import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const roots = ['.github', 'apps', 'packages', 'database', 'scripts', 'tests', 'docs', 'deploy'];
const standalone = [
  '.dockerignore',
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc.json',
  'Dockerfile',
  'compose.yaml',
  'compose.preview.yaml',
  'package.json',
  'package-lock.json',
  'playwright.config.ts',
  'tsconfig.base.json',
  'README.md',
];
const sources = [...standalone];
async function walk(relative) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (
      ['node_modules', 'dist', '.local', '.git'].includes(entry.name) ||
      entry.name.startsWith('.env')
    )
      continue;
    const filename = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await walk(filename);
    else if (entry.isFile()) sources.push(filename);
  }
}
for (const directory of roots) await walk(directory);
sources.sort();
const sha = (value) => createHash('sha256').update(value).digest('hex');
const files = [];
for (const filename of sources) {
  const content = await readFile(path.join(root, filename));
  files.push({ path: filename, bytes: content.length, sha256: sha(content) });
}
const fingerprint = sha(JSON.stringify(files));
const id = `apuntado-pmv-${fingerprint.slice(0, 12)}`;
const staging = path.join(root, '.local', 'releases', id);
for (const file of files) {
  const destination = path.join(staging, file.path);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, file.path), destination);
}
await writeFile(
  path.join(staging, 'release-manifest.json'),
  JSON.stringify(
    { id, sourceSHA256: fingerprint, createdAt: new Date().toISOString(), files },
    null,
    2,
  ) + '\n',
);
const archive = path.join(root, '.local', 'releases', `${id}.zip`);
const result = spawnSync('tar', ['-a', '-c', '-f', archive, '-C', staging, '.'], {
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Could not create the release archive');
const archiveSHA256 = sha(await readFile(archive));
await writeFile(`${archive}.sha256`, `${archiveSHA256}  ${id}.zip\n`);
console.log(
  JSON.stringify(
    { id, files: files.length, sourceSHA256: fingerprint, archive, archiveSHA256 },
    null,
    2,
  ),
);
