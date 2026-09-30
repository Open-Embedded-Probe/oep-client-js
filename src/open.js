// @ts-check
// A Host on a transport: the link started, the probe confirmed (its limits bound to the link).
import { Link } from './link.js';
import { Host } from './host.js';

/**
 * @param {import('./link.js').Transport} transport
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function connect(transport, { timeoutMs = 3000 } = {}) {
  const link = new Link(transport, { timeoutMs });
  await link.start();
  const host = new Host(link);
  await host.confirm();
  return host;
}
