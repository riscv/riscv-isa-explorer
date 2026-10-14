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
 * `assemblyOnly` means LLVM accepts and assembles it but generates no code;
 * `through` lists the parts a bundle is known by (Linux has Zba, Zbb and Zbs
 * but no `b`); `parts` is { since, via } when a -march tool took every part
 * before it took the bundle's name.
 * `earliest` means the scan's first release already had it, so "since" reads
 * as "this release or earlier"; `experimentalEarliest` is the same for the
 * experimental start of a supported extension.
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
      experimentalEarliest: Boolean(entry.experimental) && entry.experimental === first,
      options: entry.options ?? [],
      impliedBy: entry.impliedBy ?? null,
      assemblyOnly: Boolean(entry.assemblyOnly),
      through: entry.through ?? null,
      parts: entry.parts ?? null,
    };
  }
  if (entry?.experimental) {
    return {
      state: 'experimental',
      since: entry.experimental,
      earliest: entry.experimental === first,
      options: entry.options ?? [],
      impliedBy: entry.impliedBy ?? null,
      assemblyOnly: Boolean(entry.assemblyOnly),
      through: entry.through ?? null,
      parts: entry.parts ?? null,
      newest,
    };
  }
  return { state: 'none', newest, parts: entry?.parts ?? null };
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

/*
 * The history behind the chips, for the Evolution view: at each release of
 * each tool, how many of the catalogue's extensions it knew, and which were
 * new. "Knew" is the same reading as everywhere else: accepted in -march
 * (Clang, GCC), assembled (binutils), emulated (QEMU), detected (Linux), and
 * supported rather than experimental.
 *
 * A tool's first scanned release is a floor (`floor: true`): it counts
 * everything that release already had, which built up over earlier releases
 * the scan does not read. `ratified` is how many of the same extensions had
 * been ratified by each month, from `ratifiedByToken` (token -> "YYYY-MM"),
 * as a reference line.
 */
export function toolchainTimeline(data, ratifiedByToken, keys = Object.keys(data?.tools ?? {})) {
  if (!data?.tools) return { tools: [], ratified: [], from: null, to: null };
  const tokens = Object.keys(data.extensions ?? {});
  const tools = keys
    .filter((key) => data.tools[key]?.releases?.every((r) => r.date))
    .map((key) => {
      const tool = data.tools[key];
      const index = new Map(tool.releases.map((r, i) => [r.version, i]));
      const since = (token) => index.get(data.extensions[token]?.[key]?.supported) ?? Infinity;
      let count = 0;
      const points = tool.releases.map((release, i) => {
        const added = tokens.filter((token) => since(token) === i).sort();
        count += added.length;
        return { version: release.version, date: release.date, count, added, floor: i === 0 };
      });
      return { key, name: tool.name, points };
    });
  const dates = tools.flatMap((t) => t.points.map((p) => p.date)).sort();
  const from = dates[0] ?? null;
  const to = dates.at(-1) ?? null;
  // One step per month in which one of these extensions was ratified, plus
  // the count already ratified when the window opens.
  const months = tokens
    .map((token) => ratifiedByToken.get(token))
    .filter(Boolean)
    .sort();
  const ratified = [];
  if (from) {
    const start = from.slice(0, 7);
    let count = months.filter((m) => m <= start).length;
    ratified.push({ date: from, count });
    for (const month of [...new Set(months)].filter((m) => m > start && m <= to.slice(0, 7))) {
      count += months.filter((m) => m === month).length;
      ratified.push({ date: `${month}-01`, count });
    }
  }
  return { tools, ratified, from, to };
}
