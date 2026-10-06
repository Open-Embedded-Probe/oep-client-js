// @ts-check
// Interface names (oep-spec docs/capability-identification-comparison.ja.md, draft).
//
// A name is dot-separated labels of lowercase ASCII letters, digits and '-' - each label 1 or more of them, not
// starting or ending with '-', at least two labels - 1 to 64 bytes (core §7.2, §13 rule 1). The first label says which
// kind of namespace it is:
//
//   oep.                      the project's own interfaces (the reserved short prefix in place of a reverse-DNS name,
//                             core §13 rule 1; `oep` is not a real top-level domain) - otherwise like any interface
//   local.                    bench-only experiments, never published, no interoperability promise
//   uuid.<32 hex>.            an author with no domain who still wants a unique namespace
//   <tld>.<domain>...         reverse DNS of a domain the author owns, including hosting domains such as
//                             io.github.<name> (GitHub gives <name>.github.io to one owner)

import * as reg from './registry.js';

export const MAX_NAME = reg.LIMITS.interface_name_max_bytes;   // 64 (core §7.2)
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;              // no '-' at either end (core §13 rule 1)
const TLD = /^[a-z]{2,63}$/;
const UUID = /^[0-9a-f]{32}$/;

/** A name that breaks a rule; the message says which. */
export class InvalidName extends Error {}

/** 'oep', 'local', 'uuid' or 'domain' - after validate().
 * @param {string} name @returns {'oep' | 'local' | 'uuid' | 'domain'} */
export function kind(name) {
  const first = name.split('.', 1)[0];
  return first === 'oep' ? 'oep' : first === 'local' ? 'local' : first === 'uuid' ? 'uuid' : 'domain';
}

/** @param {string} s */
const q = (s) => `'${s}'`;

/** The name, or throws InvalidName saying which rule it breaks.
 * @param {string} name */
export function validate(name) {
  if (!/^[\x00-\x7f]*$/.test(name)) throw new InvalidName(`${q(name)}: not ASCII`);
  if (name.length > MAX_NAME) throw new InvalidName(`${q(name)}: ${name.length} bytes, the limit is ${MAX_NAME}`);
  const labels = name.split('.');
  if (labels.length < 2) throw new InvalidName(`${q(name)}: needs a namespace and at least one more label`);
  for (const label of labels) {
    if (!LABEL.test(label)) throw new InvalidName(`${q(name)}: label ${q(label)} is not [a-z0-9-]+ without '-' at either end`);
  }
  const first = labels[0];
  if (first === 'uuid') {
    if (labels.length < 3 || !UUID.test(labels[1])) {
      throw new InvalidName(`${q(name)}: uuid. must be followed by 32 lowercase hex digits and a name`);
    }
  } else if (first !== 'oep' && first !== 'local') {
    if (!TLD.test(first)) throw new InvalidName(`${q(name)}: ${q(first)} is not a top-level domain (reverse DNS expected)`);
    if (labels.length < 3) throw new InvalidName(`${q(name)}: reverse DNS needs <tld>.<domain>.<name>`);
  }
  return name;
}

// Hosting services whose domain is often written wrongly as a top level. Whether a first label is a real top-level
// domain is not checked (that needs the IANA list); these are the common slips.
/** @type {Record<string, string>} */
const HOSTING = { github: 'io.github', gitlab: 'io.gitlab', codeberg: 'page.codeberg', bitbucket: 'io.bitbucket' };

/** Warnings for names that are well-formed but break the namespace rules in spirit.
 * @param {string} name @returns {string[]} */
export function lint(name) {
  const labels = name.split('.');
  /** @type {string[]} */
  const out = [];
  if (Object.hasOwn(HOSTING, labels[0])) {
    out.push(`${q(labels[0])} is not a top-level domain; a ${labels[0]} account's namespace is `
      + `${HOSTING[labels[0]]}.${labels.length > 1 ? labels[1] : '<name>'}`);
  }
  if (labels[0] === 'com' && labels.length > 1 && Object.hasOwn(HOSTING, labels[1])) {
    out.push(`com.${labels[1]} is not given to accounts; use ${HOSTING[labels[1]]}.<name>`);
  }
  return out;
}

/**
 * List filtering (core §7.2): an empty prefix matches everything; otherwise match on label boundaries.
 * oep.fixture.uart matches oep.fixture.uart and oep.fixture.uart.stream, not oep.fixture.uart2; with exact, only
 * oep.fixture.uart itself.
 * @param {string} name @param {string} prefix @param {boolean} exact
 */
export function matches(name, prefix, exact = false) {
  if (!prefix) return !exact;
  if (exact) return name === prefix;
  return name === prefix || name.startsWith(`${prefix}.`);
}
