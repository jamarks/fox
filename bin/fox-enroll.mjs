#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createEnrollment, parsePublicOrigin } from '../enrollment.mjs';

try {
  const origin = parsePublicOrigin(process.env.FOX_PUBLIC_ORIGIN);
  if (!origin) throw new Error('Set FOX_PUBLIC_ORIGIN=https://fox.your-domain before running this command');
  const stateDir = join(homedir(), '.config', 'fox');
  try {
    await readFile(join(stateDir, 'passkey.json'));
    throw new Error('A passkey is already registered. Enrollment is only for first setup.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const code = await createEnrollment(stateDir, origin.origin);
  console.log(`Open ${origin.origin}/ in your browser. Enter this one-time enrollment code within 10 minutes:\n${code}\nDo not share or paste it into a URL.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
