// @ts-check
// A Host on a transport: the link started, the probe confirmed (its limits bound to the link).
import { Link } from './link.js';
import { Host } from './host.js';
import * as core from './core.js';
import { raiseSpeed } from './speed.js';

/**
 * portSpeed: rates to try, in order (opt-in, oep-core §3.5, speed.js): the lock is taken (core.take, `leaseMs`,
 * `owner`) and left open for the caller - who goes on in that session, never opening another (a new session would end
 * this one, and the rate with it) - and raiseSpeed runs; its report is `host.link.speed`.
 * @param {import('./link.js').Transport} transport
 * @param {{ timeoutMs?: number, portSpeed?: number[], leaseMs?: number, owner?: string }} [opts]
 */
export async function connect(transport, { timeoutMs = 3000, portSpeed, leaseMs = 3000, owner } = {}) {
  const link = new Link(transport, { timeoutMs });
  await link.start();
  const host = new Host(link);
  await host.confirm();
  if (portSpeed?.length) {
    await core.take(host, leaseMs, { owner, exclusive: transport.kind === 'serial' });
    await raiseSpeed(host, portSpeed);
  }
  return host;
}
