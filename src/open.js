// @ts-check
// A Host on a transport: the link started, the probe confirmed (its limits bound to the link).
import { Link } from './link.js';
import { Host } from './host.js';
import * as core from './core.js';
import * as reg from './registry.js';
import { NotOepProbe, UnitIdMismatch } from './errors.js';
import { DEFAULT_CANDIDATES, raiseSpeed } from './speed.js';

/** The probing rule's wait for confirm's answer (core §3.3, §4.4: confirm sets no time, so 1000 ms). */
export const PROBE_WAIT_MS = reg.TIMING.host_wait_add_ms;

/**
 * The probing rule (core §3.3): every transport this client opens is one it has not identified (no project VID:PID is
 * listed yet), so the first thing sent is a confirm, and nothing else until a valid answer (completed, the same corr, a
 * payload starting OEP!) came back. None: the link is closed and NotOepProbe thrown. Vendor bulk / HID: one confirm
 * and its one §5.2 resend, each waiting PROBE_WAIT_MS. A serial port (COBS) first runs Link.waitBootSpeed's confirms
 * (core §3.5 host obligation 7: about 4 s at the boot speed, a raised rate a host that died left over going back),
 * confirms only. TCP (a host-side broker, which opens the probe itself) keeps the link's timeout.
 * @param {Link} link @param {Host} host @param {import('./link.js').Transport} transport
 */
async function probe(link, host, transport) {
  const saved = link.timeoutMs;
  link.probing = true;                       // no §5.1 resync: its confirms would be more than the rule allows
  try {
    if (transport.framing === 'cobs' && transport.kind === 'serial') await link.waitBootSpeed();
    else if (transport.kind !== 'tcp') link.timeoutMs = PROBE_WAIT_MS;
    return await host.confirm();
  } catch (e) {
    link.timeoutMs = saved;
    try { await link.close(); } catch { /* already gone */ }
    const err = new NotOepProbe(`${transport.kind ?? 'transport'}: no valid confirm answer (${e instanceof Error ? e.message : e}); closed, nothing else sent (core §3.3)`);
    /** @type {any} */ (err).cause = e;
    throw err;
  } finally {
    link.timeoutMs = saved;
    link.probing = false;
  }
}

/**
 * A device opened by its named unit id (core §3.3): after confirm, fn 0's describe must say that unit_id; otherwise the
 * link is closed and UnitIdMismatch thrown (nothing else is sent).
 * @param {Host} host @param {string} unitId
 */
export async function checkUnitId(host, unitId) {
  let said = null;
  try {
    said = (await core.probeInfo(host)).unitId;
  } catch (e) {
    try { await host.link.close(); } catch { /* already gone */ }
    const err = new UnitIdMismatch(`unit id ${unitId}: describe failed (${e instanceof Error ? e.message : e}); closed`);
    /** @type {any} */ (err).cause = e;
    throw err;
  }
  if (said === null || said.toLowerCase() !== unitId.toLowerCase()) {
    try { await host.link.close(); } catch { /* already gone */ }
    throw new UnitIdMismatch(`the device named ${unitId} says unit_id ${said === null ? 'none' : JSON.stringify(said)} in describe; closed`);
  }
}

/**
 * portSpeed: the candidates to try, in order (opt-in, oep-core §3.5, speed.js; true = raiseSpeed's default, 500000):
 * the lock is taken (core.take, `leaseMs`, `owner`) and left open for the caller - who goes on in that session, never
 * opening another (a new session would end this one, and the rate with it) - and `raiseSpeed(host, candidates, {
 * flows, verify, record })` runs (the minimal form unless `verify` / `flows` ask for the full one; `record` off by
 * default); its report is `host.link.speed`. The transport is probed first (core §3.3, `probe` above): a confirm only,
 * and no valid answer closes it (NotOepProbe); on a serial port (COBS) the first confirm is retried for about 4 s
 * (Link.waitBootSpeed): a raised rate a host that died left over goes back by then. `unitId`: the unit the device was
 * opened as (by its USB serial): fn 0's describe must say the same unit_id, else the link is closed (UnitIdMismatch).
 * @param {import('./link.js').Transport} transport
 * @param {SpeedOptions & { timeoutMs?: number, leaseMs?: number, owner?: string, unitId?: string }} [opts]
 */
export async function connect(transport, { timeoutMs = 3000, portSpeed, flows, verify, record, leaseMs = 3000, owner, unitId } = {}) {
  const link = new Link(transport, { timeoutMs });
  await link.start();
  const host = new Host(link);
  await probe(link, host, transport);
  if (unitId) await checkUnitId(host, unitId);
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
