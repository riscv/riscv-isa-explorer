/**
 * Which releases of each tool know an extension, or a whole -march string,
 * read from src/toolchain-support.json (scripts/sync_toolchain_support.mjs).
 *
 * Pure: the data is passed in, as with marchUtils.js.
 */

/* What builds code for an extension, and what runs it. */
export const BUILD_TOOLS = ['llvm', 'gcc', 'binutils'];
export const RUN_TOOLS = ['qemu', 'linux'];

/* Versions are compared by their place in the tool's release list, never as
   numbers: Linux 6.10 comes after 6.9. */
const releaseIndex = (tool, version) => tool.releases.findIndex((r) => r.version === version);

/*
 * The token a catalogue extension is looked up by. A base keeps its width
 * (rv64e, rv128i): tools added RV64E years after RV32E, and RV128I is in no
 * compiler at all, so a shared 'e' or 'i' would claim support that is not
 * there.
 */
export function marchToken(id) {
  return String(id || '').toLowerCase() || null;
}

/*
 * One tool's standing for one token:
 *   { state: 'supported', since, experimentalSince?, earliest, options, impliedBy? }
 *   { state: 'experimental', since, options, impliedBy? }
 *   { state: 'none', newest }
 * `options` lists QEMU's switch for an experimental extension as it was
 * spelled over time, [{ option, from }], the last one current;
 * `impliedBy` names the extension QEMU provides it with (V for Zvl256b);
 * `assemblyOnly` means LLVM accepts and assembles it but generates no code.
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
      options: entry.options ?? [],
      impliedBy: entry.impliedBy ?? null,
      assemblyOnly: Boolean(entry.assemblyOnly),
    };
  }
  if (entry?.experimental) {
    return {
      state: 'experimental',
      since: entry.experimental,
      earliest: entry.experimental === first,
      options: entry.options ?? [],
      impliedBy: entry.impliedBy ?? null,
      newest,
    };
  }
  return { state: 'none', newest };
}

/*
 * Per tool, how the extension `id` stands. Null when it has no entry at all:
 * privilege modes, satp modes and sandbox extensions are not -march tokens,
 * so "not yet supported" would be a false answer for them.
 */
export function extensionSupport(data, id, keys = Object.keys(data?.tools ?? {})) {
  const token = marchToken(id);
  if (!token || !data?.tools || !data.extensions?.[token]) return null;
  const entry = data.extensions?.[token];
  return keys
    .filter((key) => data.tools[key])
    .map((key) => ({
      key,
      token,
      name: data.tools[key].name,
      ...standingFor(data.tools[key], entry?.[key]),
    }));
}

/*
 * The tokens of a -march string: the base with its width (rv64i), the other
 * single letters, then the rest.
 */
export function marchTokens(march) {
  const m = String(march || '')
    .toLowerCase()
    .match(/^rv(32|64|128)([ie])([a-z]*)(.*)$/);
  if (!m) return [];
  const [, xlen, base, letters, rest] = m;
  return [`rv${xlen}${base}`, ...letters.split(''), ...rest.split('_').filter(Boolean)];
}

/*
 * What a -march string needs from each build tool:
 *   { key, name, minimum, experimental: [tokens], missing: [tokens],
 *     assemblyOnly: [tokens], newest }
 * `minimum` is the newest "supported since" among its tokens. `experimental`
 * lists tokens that release takes only behind -menable-experimental-extensions;
 * `missing` lists tokens no release accepts yet. Tokens the data does not know
 * at all (a sandbox extension) are left out rather than guessed.
 */
export function marchRequirements(data, march, keys = BUILD_TOOLS) {
  if (!data?.tools) return [];
  const tokens = marchTokens(march).filter((token) => data.extensions?.[token]);
  return keys
    .filter((key) => data.tools[key])
    .map((key) => {
      const tool = data.tools[key];
      const result = {
        key,
        name: tool.name,
        minimum: null,
        experimental: [],
        missing: [],
        assemblyOnly: [],
        newest: tool.releases.at(-1)?.version,
      };
      for (const token of tokens) {
        const s = standingFor(tool, data.extensions[token][key]);
        if (s.state === 'none') result.missing.push(token);
        else if (s.state === 'experimental') result.experimental.push(token);
        if (s.assemblyOnly) result.assemblyOnly.push(token);
        if (
          s.state !== 'none' &&
          (!result.minimum || releaseIndex(tool, s.since) > releaseIndex(tool, result.minimum))
        ) {
          result.minimum = s.since;
        }
      }
      return result;
    });
}
