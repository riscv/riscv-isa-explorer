/**
 * profileGap.js — what a builder configuration lacks for a profile (#583).
 *
 * The profile's extensions are classified by profileMembership(), the same
 * function behind the profile highlight and the profile download, so the three
 * cannot disagree about what a profile contains. This module only measures a
 * configuration against that classification. Pure: no React, no data imports;
 * the caller passes the profile lists, the closure and the catalogue ids.
 */
import { profileMembership } from './profileExport.js';

const byId = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });

/**
 * @param {object} p
 * @param {Iterable<string>} p.configIds the configuration, already
 *   dependency-resolved (the builder's set is)
 * @param {string[]} p.mandatory the profile's mandatory list
 * @param {string[]} [p.optional] the profile's optional list
 * @param {(id: string) => Iterable<string>} p.closure transitive requirements
 * @param {Set<string>} [p.known] catalogue ids. An implied id outside the
 *   catalogue can never be in a configuration, so it is left out rather than
 *   reported as permanently missing.
 * @param {Set<string>} [p.bases] base ISA ids, to report a base mismatch
 */
export function profileGap({ configIds, mandatory, optional = [], closure, known, bases }) {
  const config = new Set(configIds);
  const membership = profileMembership({ mandatory, optional, closure });
  const inScope = (id, entry) => !known || known.has(id) || entry.requirement === 'mandatory';

  const missingMandatory = [];
  const missingImplied = [];
  const optionalPresent = [];
  const optionalAbsent = [];
  let required = 0;
  let requiredPresent = 0;

  for (const [id, entry] of membership) {
    if (!inScope(id, entry)) continue;
    if (entry.requirement === 'optional') {
      (config.has(id) ? optionalPresent : optionalAbsent).push(id);
      continue;
    }
    required += 1;
    if (config.has(id)) {
      requiredPresent += 1;
    } else if (entry.requirement === 'mandatory') {
      missingMandatory.push(id);
    } else {
      missingImplied.push({ id, impliedBy: entry.impliedBy });
    }
  }

  const beyond = [...config].filter((id) => !membership.has(id) && !bases?.has(id));

  let base = null;
  if (bases) {
    const wanted = mandatory.find((id) => bases.has(id)) ?? null;
    const have = [...config].find((id) => bases.has(id)) ?? null;
    if (wanted && have !== wanted) base = { wanted, have };
  }

  missingMandatory.sort(byId);
  missingImplied.sort((a, b) => byId(a.id, b.id));
  optionalPresent.sort(byId);
  optionalAbsent.sort(byId);
  beyond.sort(byId);

  return {
    meets: missingMandatory.length === 0 && missingImplied.length === 0,
    required,
    requiredPresent,
    base,
    missingMandatory,
    missingImplied,
    optionalPresent,
    optionalAbsent,
    beyond,
  };
}
