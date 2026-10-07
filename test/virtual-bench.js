// @ts-check
// oep-client-python's virtual bench (python -m oep_client.virtual_bench_serve) over TCP, for the tests: a probe, the
// targets behind it and the fixture wiring, modelled after the real jigs. OEP_PYTHON names the Python that has
// oep-client-python (default: its sibling checkout's .venv, else python3); without it the tests that need the virtual
// bench are skipped.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sibling = resolve(here, '..', '..', 'oep-client-python', '.venv', 'bin', 'python');
export const PYTHON = process.env.OEP_PYTHON ?? (existsSync(sibling) ? sibling : 'python3');

export const haveVirtualBench =
  spawnSync(PYTHON, ['-c', 'import oep_client.virtual_bench_serve'], { stdio: 'ignore' }).status === 0;

/** A fresh directory for the kept session ids (keptsession.js, $OEP_SESSION_DIR): no test keeps them in the user's cache
 * directory, and each virtual bench starts with none kept (a host run again on it is a test's own doing). */
export function freshSessionDir() {
  process.env.OEP_SESSION_DIR = mkdtempSync(join(tmpdir(), 'oep-sessions-'));
  return process.env.OEP_SESSION_DIR;
}

/**
 * Start a virtual bench (in a fresh $OEP_SESSION_DIR); resolves with its TCP port and a stop().
 * @param {string[]} args  virtual_bench_serve options (--profile, --slot, ...)
 * @param {'length' | 'cobs'} framing
 * @returns {Promise<{ port: number, stop: () => void, send: (line: string) => void }>}
 */
export function startVirtualBench(args = [], framing = 'length') {
  freshSessionDir();
  return new Promise((resolvePort, reject) => {
    const child = spawn(PYTHON, ['-m', 'oep_client.virtual_bench_serve', '--tcp', '0', '--framing', framing, ...args],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      const hit = out.match(/PORT (\d+)/);
      if (hit) {
        resolvePort({
          port: Number(hit[1]),
          stop: () => { child.stdin.end(); child.kill(); },
          send: (line) => { child.stdin.write(`${line}\n`); },
        });
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!/PORT/.test(out)) reject(new Error(`virtual_bench_serve exited (${code}) before its port`));
    });
  });
}

export { join };
