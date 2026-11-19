// Server setup takes deploy files from the script's checkout only when the script has a real path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const setup = new URL('../setup-server.sh', import.meta.url);

async function selection() {
  const source = await readFile(setup, 'utf8');
  const start = source.indexOf('# Only a real script file can identify a checkout;');
  const end = source.indexOf('\nstep "System packages"', start);
  assert.ok(start !== -1 && end !== -1, 'setup source-selection block exists');
  return `set -euo pipefail\nFOX_REPO=https://github.com/example/fox.git\nFOX_REF=selected\nfail() { echo "$*" >&2; exit 1; }\n${source.slice(start, end)}\nprintf '%s\\n' "$SRC"\ncat "$DEPLOY/fox-update"\n`;
}

test('piped server setup fetches deploy files instead of using the caller directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fox-setup-'));
  try {
    const caller = join(dir, 'caller');
    const archiveRoot = join(dir, 'archive');
    const archive = join(dir, 'selected.tar.gz');
    const bin = join(dir, 'bin');
    await mkdir(join(caller, 'deploy'), { recursive: true });
    await mkdir(join(archiveRoot, 'fox-selected', 'deploy'), { recursive: true });
    await mkdir(bin);
    await writeFile(join(caller, 'deploy', 'fox-update'), 'caller updater\n');
    await writeFile(join(archiveRoot, 'fox-selected', 'deploy', 'fox-update'), 'selected updater\n');
    execFileSync('tar', ['-czf', archive, '-C', archiveRoot, 'fox-selected']);
    await writeFile(join(bin, 'curl'), '#!/bin/sh\n[ "$1" = -fsSL ] && [ "$2" = https://github.com/example/fox/archive/selected.tar.gz ] || exit 1\ncat "$FOX_TEST_ARCHIVE"\n', { mode: 0o755 });
    const stdout = execFileSync('bash', ['-s'], {
      cwd: caller,
      input: await selection(),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOX_TEST_ARCHIVE: archive },
      encoding: 'utf8',
    });
    const [source, updater] = stdout.trim().split('\n');
    assert.notEqual(source, caller);
    assert.equal(updater, 'selected updater');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('server setup executed through a symlink uses the script checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fox-setup-file-'));
  try {
    const caller = join(dir, 'caller');
    const checkout = join(dir, 'checkout');
    await mkdir(join(caller, 'deploy'), { recursive: true });
    await mkdir(join(checkout, 'deploy'), { recursive: true });
    await writeFile(join(checkout, 'deploy', 'fox-update'), 'checkout updater\n');
    await writeFile(join(caller, 'deploy', 'fox-update'), 'caller updater\n');
    await writeFile(join(checkout, 'setup-server.sh'), await selection());
    await symlink(join(checkout, 'setup-server.sh'), join(caller, 'setup-server.sh'));
    const stdout = execFileSync('bash', [join(caller, 'setup-server.sh')], { cwd: caller, encoding: 'utf8' });
    assert.equal(stdout, `${checkout}\ncheckout updater\n`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
