/**
 * Share links for a highlighted profile and for a builder configuration (#407).
 *
 * Pure on purpose, in the style of workspaceLock.js: no React, no data
 * imports. The catalogue ids and the profile table are passed in, so the
 * encoding can be tested without rendering anything.
 *
 * The configuration is written as a delta from its profile rather than as the
 * exported JSON. RVA23 alone is some forty extensions; a link that spelled
 * them out would be long enough to break in chat clients and mail, and would
 * stop matching the profile the day the profile gains an extension. What the
 * person chose is the profile plus what they added and removed, so that is
 * what the link records:
 *
 *   1;p:RVA23.1;a:Zbc,Zfh;r:H;u;o:VLEN=256
 *
 *   1      format version, so a later change can still read old links
 *   p:X    seeded from profile X, still compliant
 *   c:X    started from profile X, since diverged ("Custom (from X)")
 *   a:...  extensions added on top of the profile (all of them when no profile)
 *   r:...  the profile's mandatory extensions that were removed
 *   u      the profile floor was released
 *   o:...  parameter choices, NAME=value, values URI-encoded
 *
 * The separators are written literally, not percent-encoded: `;`, `:`, `,` and
 * `=` are all legal in a query string, and a link people can read is one they
 * can trust and trim. Only parameter values are encoded, once. readConfigParam
 * reads the raw query for that reason, and still accepts a link some client
 * has re-escaped on the way.
 *
 * A link outlives the catalogue it was made from. Nothing here trusts it:
 * decoding only splits the string, and sanitizeBuilderState checks every field
 * against live data, exactly as it does for a payload read back from
 * localStorage.
 */

export const PROFILE_PARAM = 'profile';
export const CONFIG_PARAM = 'cfg';

const FORMAT_VERSION = '1';

/**
 * The `cfg` value from a query string, as encodeBuilderConfig wrote it.
 *
 * URLSearchParams would decode the value once, turning an encoded `,` inside a
 * parameter value into a real separator. So the raw text is used when its
 * separators arrived intact, and the decoded one only when they did not, which
 * is what a client that re-escaped the whole link sends.
 */
export const readConfigParam = (search) => {
  const query = typeof search === 'string' ? search.replace(/^\?/, '') : '';
  const raw = query
    .split('&')
    .find((pair) => pair.startsWith(`${CONFIG_PARAM}=`))
    ?.slice(CONFIG_PARAM.length + 1);
  if (raw === undefined) return null;
  if (raw.includes(';')) return raw;
  return new URLSearchParams(query).get(CONFIG_PARAM);
};

/** The query string for a configuration link, separators left readable. */
export const configQuery = (value) => (value ? `?${CONFIG_PARAM}=${value}` : '');

/** The canonical profile name for `name`, ignoring case, or null. */
export const findProfileName = (name, profiles) => {
  if (typeof name !== 'string' || !name.trim()) return null;
  const wanted = name.trim().toLowerCase();
  return Object.keys(profiles || {}).find((key) => key.toLowerCase() === wanted) ?? null;
};

/*
 * Parameter values come from oneOf option lists, which hold numbers, a few
 * strings and the odd boolean. The link has no types, so the literal forms of
 * numbers and booleans are read back as those; anything else is a string.
 */
const encodeValue = (value) => encodeURIComponent(String(value));
const decodeValue = (text) => {
  let raw;
  try {
    raw = decodeURIComponent(text);
  } catch {
    return undefined;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
};

/**
 * Encodes the builder for the `cfg` parameter.
 *
 * @returns {string} '' when there is nothing worth sharing
 */
export const encodeBuilderConfig = (
  { workspaceIds, seedProfile, customFromProfile, paramChoices, baselineLocked },
  profiles = {},
) => {
  const ids = [...(workspaceIds ?? [])].filter(Boolean);
  if (ids.length === 0) return '';

  const base = seedProfile || customFromProfile || null;
  const mandatory = new Set(base ? profiles[base] || [] : []);
  const selected = new Set(ids);

  const added = ids.filter((id) => !mandatory.has(id)).sort();
  const removed = [...mandatory].filter((id) => !selected.has(id)).sort();

  const parts = [FORMAT_VERSION];
  if (base) parts.push(`${seedProfile ? 'p' : 'c'}:${base}`);
  if (added.length) parts.push(`a:${added.join(',')}`);
  if (removed.length) parts.push(`r:${removed.join(',')}`);
  if (base && baselineLocked === false) parts.push('u');

  const options = Object.entries(paramChoices ?? {})
    .filter(([name, value]) => name && value !== null && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${encodeValue(value)}`);
  if (options.length) parts.push(`o:${options.join(',')}`);

  return parts.join(';');
};

/**
 * Splits a `cfg` value back into the shape the builder persists, unchecked.
 * Pass the result through sanitizeBuilderState before using it.
 *
 * @returns {object|null} null when the value is not a configuration link
 */
export const decodeBuilderConfig = (value, profiles = {}) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const [version, ...segments] = raw.split(';');
  if (version !== FORMAT_VERSION) return null;

  let seedProfile = null;
  let customFromProfile = null;
  let added = [];
  let removed = [];
  let baselineLocked = true;
  const paramChoices = {};

  const list = (text) =>
    text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  for (const segment of segments) {
    const colon = segment.indexOf(':');
    const key = colon === -1 ? segment : segment.slice(0, colon);
    const body = colon === -1 ? '' : segment.slice(colon + 1);
    if (key === 'p') seedProfile = findProfileName(body, profiles);
    else if (key === 'c') customFromProfile = findProfileName(body, profiles);
    else if (key === 'a') added = list(body);
    else if (key === 'r') removed = list(body);
    else if (key === 'u') baselineLocked = false;
    else if (key === 'o') {
      for (const pair of list(body)) {
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const decoded = decodeValue(pair.slice(eq + 1));
        if (decoded !== undefined) paramChoices[pair.slice(0, eq)] = decoded;
      }
    }
    // Unknown segments are skipped, so a newer link still opens here.
  }

  const base = seedProfile || customFromProfile;
  const removedSet = new Set(removed);
  const fromProfile = base ? (profiles[base] || []).filter((id) => !removedSet.has(id)) : [];
  const workspaceIds = [...new Set([...fromProfile, ...added])];
  if (workspaceIds.length === 0) return null;

  return { workspaceIds, seedProfile, customFromProfile, paramChoices, baselineLocked };
};

/**
 * Validates a builder payload against live data rather than trusting it.
 *
 * Everything here has been out of our hands since it was written: the payload
 * may predate a catalogue sync that renamed an extension, predate a change to
 * a profile's mandatory set, or have been edited by hand. A shape check alone
 * let unknown ids and a non-object paramChoices flow into -march assembly, so
 * each field is checked against live data and dropped if it no longer refers
 * to anything.
 *
 * The reconciliation at the end matters most. `baselineLocked` is stored
 * independently of `workspaceIds`, so a payload can claim the profile floor is
 * held while the selection has already lost a mandatory extension, the
 * false-compliance state #214 exists to prevent. When the two disagree we
 * believe the extension set and release the lock, which tells the truth and
 * leaves the configuration untouched; re-locking restores the floor as it
 * always has.
 *
 * @param {object} parsed payload from localStorage or decodeBuilderConfig
 * @param {object} ctx
 * @param {Set<string>} ctx.catalogIds every extension id the catalogue has
 * @param {object} ctx.profiles profile name -> mandatory ids
 * @param {Function} ctx.missingMandatory from workspaceLock.js
 * @param {Set<string>} [ctx.paramNames] parameters isa-params.json defines;
 *   when given, choices for anything else are dropped
 */
export const sanitizeBuilderState = (
  parsed,
  { catalogIds, profiles = {}, missingMandatory, paramNames },
) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const knownProfile = (name) =>
    typeof name === 'string' && Object.hasOwn(profiles, name) ? name : null;

  const workspaceIds = Array.isArray(parsed.workspaceIds)
    ? parsed.workspaceIds.filter((id) => catalogIds.has(id))
    : [];

  const paramChoices =
    parsed.paramChoices &&
    typeof parsed.paramChoices === 'object' &&
    !Array.isArray(parsed.paramChoices)
      ? Object.fromEntries(
          Object.entries(parsed.paramChoices).filter(
            ([name]) => !paramNames || paramNames.has(name),
          ),
        )
      : {};

  let seedProfile = knownProfile(parsed.seedProfile);
  let customFromProfile = knownProfile(parsed.customFromProfile);
  let baselineLocked = typeof parsed.baselineLocked === 'boolean' ? parsed.baselineLocked : true;

  if (seedProfile && baselineLocked) {
    const missing = missingMandatory({ workspaceIds, seedProfile, profiles });
    if (missing.length > 0) {
      customFromProfile = seedProfile;
      seedProfile = null;
      baselineLocked = false;
    }
  }

  return {
    workspaceIds,
    seedProfile,
    customFromProfile,
    paramChoices,
    baselineLocked,
    builderMode: typeof parsed.builderMode === 'boolean' ? parsed.builderMode : undefined,
  };
};

/** True when two sanitised payloads describe the same configuration. */
export const sameBuilderConfig = (a, b, profiles = {}) =>
  encodeBuilderConfig(a ?? {}, profiles) === encodeBuilderConfig(b ?? {}, profiles);
