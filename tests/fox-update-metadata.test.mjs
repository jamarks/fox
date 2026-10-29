// Deployment metadata must be installed without trusting paths left behind by the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename, lstat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const updater = new URL('../deploy/fox-update', import.meta.url).pathname;
// Exercise the updater's actual install function without needing root or the server's paths.
async function install(build, identity, release, metadata) {
  return exec('bash', ['-c', 'source "$1"; fail() { echo "$*" >&2; exit 1; }; chown() { :; }; install_metadata "$2" "$3" "$4" "$5"', 'test', updater, build, identity, release, metadata]);
}

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'fox-update-metadata-'));
  const build = join(dir, 'build'), release = join(dir, 'releases', 'commit');
  const metadata = join(dir, 'staging', 'VERSION.json'), sentinel = join(dir, 'sentinel');
  try {
    await mkdir(build); await mkdir(join(dir, 'releases')); await mkdir(join(dir, 'staging'));
    await writeFile(metadata, '{"commit":"new"}\n');
    await writeFile(sentinel, 'protected original\n');
    await chmod(sentinel, 0o400);
    const { stdout } = await exec('stat', ['-c', '%d:%i', build]);
    await run({ dir, build, release, metadata, sentinel, identity: stdout.trim() });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('deploy metadata replaces a build symlink without writing to its target', () => fixture(async ({ build, identity, release, metadata, sentinel }) => {
  await symlink(sentinel, join(build, 'VERSION.json'));
  await install(build, identity, release, metadata);
  assert.equal(await readFile(sentinel, 'utf8'), 'protected original\n');
  assert.equal(await readFile(join(release, 'VERSION.json'), 'utf8'), '{"commit":"new"}\n');
  assert.equal((await lstat(join(release, 'VERSION.json'))).isFile(), true);
}));

test('deploy refuses symlinked and replaced build directories', () => fixture(async ({ dir, build, identity, release, metadata, sentinel }) => {
  await rename(build, join(dir, 'original'));
  await symlink(join(dir, 'original'), build);
  await assert.rejects(install(build, identity, release, metadata), /unsafe build directory/);
  await rm(build);
  await mkdir(build);
  await assert.rejects(install(build, identity, release, metadata), /unsafe build directory/);
  await assert.rejects(lstat(release), { code: 'ENOENT' });
  assert.equal(await readFile(sentinel, 'utf8'), 'protected original\n');
}));
