/**
 * Which Clang and GCC releases accept an extension, or a whole -march string,
 * read from src/toolchain-support.json (scripts/sync_toolchain_support.mjs).
 *
 * Pure: the data is passed in, as with marchUtils.js.
 */

/*
 * The -march token for a catalogue extension, or null when it has none. The
 * bases share 'i' and 'e' across widths; RV128I has no toolchain.
 */
export function marchToken(id) {
  if (/^RV(32|64)I$/.test(id)) return 'i';
  if (/^RV(32|64)E$/.test(id)) return 'e';
  if (/^RV128I$/.test(id)) return null;
  return String(id || '').toLowerCase() || null;
}

/*
 * One tool's standing for one token:
 *   { state: 'supported', since, experimentalSince?, earliest }
 *   { state: 'experimental', since }
 *   { state: 'none', newest }
 * `earliest` means the scan's first release already accepted it, so "since"
 * reads as "this release or earlier".
 */
function standingFor(tool, entry) {
  const first = tool.releases[0]?.version;
  const newest = tool.releases.at(-1)?.version;
  if (entry?.supported) {
    return {
      state: 'supported',
      since: entry.supported,
      experimentalSince: entry.experimental ?? null,
      earliest: entry.supported === first,
    };
  }
  if (entry?.experimental) {
    return {
      state: 'experimental',
      since: entry.experimental,
      earliest: entry.experimental === first,
      newest,
    };
  }
  return { state: 'none', newest };
}

/* Per tool, how the extension `id` stands; null when it has no -march token. */
export function extensionSupport(data, id) {
  const token = marchToken(id);
  if (!token || !data?.tools) return null;
  const entry = data.extensions?.[token];
  return Object.entries(data.tools).map(([key, tool]) => ({
    key,
    name: tool.name,
    ...standingFor(tool, entry?.[key]),
  }));
}

/* The tokens of a -march string: the base, its single letters, then the rest. */
export function marchTokens(march) {
  const m = String(march || '')
    .toLowerCase()
    .match(/^rv(?:32|64|128)([a-z]*)(.*)$/);
  if (!m) return [];
  const [, letters, rest] = m;
  return [...letters.split(''), ...rest.split('_').filter(Boolean)];
}

/*
 * What a -march string needs from each tool:
 *   { key, name, minimum, experimental: [tokens], missing: [tokens], newest }
 * `minimum` is the newest "supported since" among its tokens. `experimental`
 * lists tokens that release takes only behind -menable-experimental-extensions;
 * `missing` lists tokens no release accepts yet. Tokens the data does not know
 * at all (a sandbox extension) are left out rather than guessed.
 */
export function marchRequirements(data, march) {
  if (!data?.tools) return [];
  const tokens = marchTokens(march).filter((token) => data.extensions?.[token]);
  return Object.entries(data.tools).map(([key, tool]) => {
    const result = {
      key,
      name: tool.name,
      minimum: null,
      experimental: [],
      missing: [],
      newest: tool.releases.at(-1)?.version,
    };
    for (const token of tokens) {
      const s = standingFor(tool, data.extensions[token][key]);
      if (s.state === 'none') result.missing.push(token);
      else if (s.state === 'experimental') result.experimental.push(token);
      if (s.state !== 'none' && (!result.minimum || Number(s.since) > Number(result.minimum))) {
        result.minimum = s.since;
      }
    }
    return result;
  });
}
