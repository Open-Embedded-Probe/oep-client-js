// @ts-check
// A Host on a transport: the link started, the probe confirmed (its limits bound to the link).
import { Link } from './link.js';
import { Host } from './host.js';
import * as core from './core.js';
import { DEFAULT_CANDIDATES, raiseSpeed } from './speed.js';

/**
 * portSpeed: the candidates to try, in order (opt-in, oep-core §3.5, speed.js; true = raiseSpeed's default, 500000):
 * the lock is taken (core.take, `leaseMs`, `owner`) and left open for the caller - who goes on in that session, never
 * opening another (a new session would end this one, and the rate with it) - and `raiseSpeed(host, candidates, {
 * flows, verify, record })` runs (the minimal form unless `verify` / `flows` ask for the full one; `record` off by
 * default); its report is `host.link.speed`. On a serial port (COBS) the first confirm is retried for about 4 s
 * (Link.waitBootSpeed): a raised rate a host that died left over goes back by then.
 * @param {import('./link.js').Transport} transport
 * @param {SpeedOptions & { timeoutMs?: number, leaseMs?: number, owner?: string }} [opts]
 */
export async function connect(transport, { timeoutMs = 3000, portSpeed, flows, verify, record, leaseMs = 3000, owner } = {}) {
  const link = new Link(transport, { timeoutMs });
  await link.start();
  const host = new Host(link);
  if (transport.framing === 'cobs' && transport.kind === 'serial') await link.waitBootSpeed();
  await host.confirm();
  if (portSpeed === true || (Array.isArray(portSpeed) && portSpeed.length)) {
    await core.take(host, leaseMs, { owner, exclusive: transport.kind === 'serial' });
    await raiseSpeed(host, portSpeed === true ? DEFAULT_CANDIDATES : portSpeed, { flows, verify, record });
  }
  return host;
}

/**
 * connect's port_speed options: `portSpeed` (true = the default candidate, or candidates in order), `flows` / `verify`
 * (the full form, speed.js raiseSpeed), `record` (the record of passed / failed rates, speedrecord.js).
 * @typedef {{ portSpeed?: boolean | number[], flows?: import('./speed.js').FlowSpec[] | null, verify?: boolean | null,
 *   record?: boolean | string | import('./speedrecord.js').SpeedRecord }} SpeedOptions
 */
