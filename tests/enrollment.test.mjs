import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { createAuth } from '../auth.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnrollment, validEnrollment, consumeEnrollment, enrollmentPath } from '../enrollment.mjs';

test('one-time SSH enrollment code is hashed on disk, scoped to origin and expires', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fox-enroll-'));
  const origin = 'https://fox.example.test';
  try {
    const code = await createEnrollment(home, origin);
    const contents = await readFile(enrollmentPath(home), 'utf8');
    assert.ok(!contents.includes(code));
    assert.equal((await stat(enrollmentPath(home))).mode & 0o777, 0o600);
    assert.equal(await validEnrollment(home, code, origin), true);
    assert.equal(await validEnrollment(home, code, 'https://other.example.test'), false);
    assert.equal(await validEnrollment(home, 'wrong', origin), false);
    assert.equal(await consumeEnrollment(home, code, origin), true);
    assert.equal(await consumeEnrollment(home, code, origin), false);
    const expired = await createEnrollment(home, origin, Date.now() - 11 * 60 * 1000);
    assert.equal(await validEnrollment(home, expired, origin), false);
    await writeFile(join(home, 'passkey.json'), JSON.stringify({ id: 'local', publicKey: 'AQ', counter: 0, rpID: 'localhost' }));
    await assert.rejects(createAuth({ stateDir: home, publicOrigin: origin }), /another domain/);
    await assert.rejects(createAuth({ stateDir: home, publicOrigin: origin, disabled: true }), /must never/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
