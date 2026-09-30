// @ts-check
// oep-client-python's fake probe (python -m oep_client.fake_serve) over TCP, for the tests. OEP_PYTHON names the
// Python that has oep-client-python (default: python3); without it the tests that need the fake are skipped.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sibling = resolve(here, '..', '..', 'oep-client-python', '.venv', 'bin', 'python');
export const PYTHON = process.env.OEP_PYTHON ?? (existsSync(sibling) ? sibling : 'python3');

export const haveFake = spawnSync(PYTHON, ['-c', 'import oep_client.fake_serve'], { stdio: 'ignore' }).status === 0;

/**
 * Start a fake probe; resolves with its TCP port and a stop().
 * @param {string[]} args  fake_serve options (--profile, --slot, ...)
 * @param {'length' | 'cobs'} framing
 */
export function startFake(args = [], framing = 'length') {
  return new Promise((resolvePort, reject) => {
    const child = spawn(PYTHON, ['-m', 'oep_client.fake_serve', '--tcp', '0', '--framing', framing, ...args],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      const hit = out.match(/PORT (\d+)/);
      if (hit) resolvePort({ port: Number(hit[1]), stop: () => { child.stdin.end(); child.kill(); } });
    });
    child.on('error', reject);
    child.on('exit', (code) => { if (!/PORT/.test(out)) reject(new Error(`fake_serve exited (${code}) before its port`)); });
  });
}

export { join };
