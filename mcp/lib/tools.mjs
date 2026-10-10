/**
 * tools.mjs — what each MCP tool answers, as plain functions.
 *
 * No SDK here: every handler takes plain arguments and returns a plain object,
 * so tests drive them directly and server.mjs only adds schemas and transport.
 *
 * The answers carry their provenance. A dependency comes back with the
 * citation its graph edge holds (udb, isa-manual, clang), and an extension
 * with its specification link and its page on the site. That is the point of
 * asking this server rather than a model's memory, so no handler drops it.
 */

export const SITE_URL = 'https://tech.riscv.org/isa-explorer/';

/** An error in what the caller asked for, reported to the client as a tool error. */
export class ToolInputError extends Error {}

const extensionPage = (id) => `${SITE_URL}ext/${id.toLowerCase()}/`;

function statusOf(ext) {
  if (ext.discontinued) return 'discontinued';
  return ext.state || 'unconfirmed';
}

export const STATUSES = [
  'ratified',
  'frozen',
  'draft',
  'development',
  'discontinued',
  'unconfirmed',
];

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** Closest known names to a miss: prefix matches, then substrings, then near typos. */
function suggest(input, names, limit = 5) {
  const q = input.toLowerCase();
  const prefix = names.filter((n) => n.toLowerCase().startsWith(q));
  const inner = names.filter((n) => !prefix.includes(n) && n.toLowerCase().includes(q));
  const near = names
    .filter((n) => !prefix.includes(n) && !inner.includes(n))
    .map((n) => [n, editDistance(q, n.toLowerCase())])
    .filter(([, d]) => d <= Math.max(1, Math.floor(q.length / 3)))
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([n]) => n);
  return [...prefix, ...inner, ...near].slice(0, limit);
}

export function createTools(x) {
  const groupLabel = new Map(x.CATALOGUE_GROUPS.map((g) => [g.key, g.label]));
  const extensions = [];
  const byId = new Map(); // lowercased id -> { ext, group }
  for (const [group, list] of Object.entries(x.catalog)) {
    for (const ext of list) {
      const entry = { ext, group: groupLabel.get(group) ?? group };
      extensions.push(entry);
      byId.set(ext.id.toLowerCase(), entry);
    }
  }
  const catalogIds = new Set(extensions.map((e) => e.ext.id));
  const flatCatalog = extensions.map((e) => e.ext);
  const nodes = x.graph.nodes ?? {};

  // Mnemonic (as the catalogue spells it, upper case) -> every extension listing it.
  const instructions = new Map();
  for (const { ext } of extensions) {
    for (const [mnemonic, details] of Object.entries(ext.instructions ?? {})) {
      if (!instructions.has(mnemonic)) instructions.set(mnemonic, []);
      instructions.get(mnemonic).push({ extId: ext.id, details });
    }
  }

  // Parsed once: decode_instruction scans every pattern on each call.
  const patterns = [...instructions.entries()].map(([mnemonic, listed]) => ({
    mnemonic,
    match: x.parseHexToBigInt(listed[0].details.match),
    mask: x.parseHexToBigInt(listed[0].details.mask),
  }));

  const profileNames = Object.keys(x.PROFILES);
  const membershipOf = (profile, withImplied = true) =>
    x.profileMembership({
      mandatory: x.PROFILES[profile],
      optional: x.profileOptional[profile] ?? [],
      closure: withImplied ? (id) => x.closure(id) : null,
    });

  function findExtension(id) {
    if (typeof id !== 'string' || !id.trim())
      throw new ToolInputError('An extension id is required.');
    const hit = byId.get(id.trim().toLowerCase());
    if (hit) return hit;
    const close = suggest(id.trim(), [...catalogIds]);
    throw new ToolInputError(
      `Unknown extension "${id}".` + (close.length ? ` Did you mean: ${close.join(', ')}?` : ''),
    );
  }

  function findProfile(name) {
    const hit = profileNames.find(
      (p) =>
        p.toLowerCase() ===
        String(name ?? '')
          .trim()
          .toLowerCase(),
    );
    if (hit) return hit;
    throw new ToolInputError(
      `Unknown profile "${name}". Known profiles: ${profileNames.join(', ')}.`,
    );
  }

  function findBase(base) {
    const hit = [...x.BASE_ISA_IDS].find(
      (b) =>
        b.toLowerCase() ===
        String(base ?? '')
          .trim()
          .toLowerCase(),
    );
    if (hit) return hit;
    throw new ToolInputError(
      `Unknown base ISA "${base}". Use one of: ${[...x.BASE_ISA_IDS].join(', ')}.`,
    );
  }

  /** The citation on the graph edge from -> to, or the one-of group that chose `to`. */
  function edgeCitation(from, to) {
    const node = nodes[from] ?? {};
    const edge = (node.requires ?? []).find((e) => e.ext === to);
    if (edge) return { from, to, source: edge.src, ref: edge.ref ?? '' };
    const choice = (node.requiresOneOf ?? []).find((c) => c.options.includes(to));
    if (choice) {
      return {
        from,
        to,
        source: choice.src,
        ref: choice.ref ?? '',
        note: `${from} requires one of ${choice.options.join(', ')}; ${to} is the default`,
      };
    }
    return { from, to, source: null, ref: '' };
  }

  const citedPath = (path) => path.slice(1).map((to, i) => edgeCitation(path[i], to));

  function profilesContaining(id) {
    const out = [];
    for (const profile of profileNames) {
      const hit = membershipOf(profile).get(id);
      if (hit) {
        out.push({
          profile,
          requirement: hit.requirement,
          ...(hit.impliedBy.length ? { implied_by: hit.impliedBy } : {}),
        });
      }
    }
    return out;
  }

  /** The -march string for a resolved selection, as CI feeds it to clang. */
  function marchFor(resolved) {
    const built = x.buildMarchString(
      resolved.filter((id) => catalogIds.has(id)),
      flatCatalog,
    );
    return { march: built.march, excluded: built.excluded, warnings: built.warnings };
  }

  function summary({ ext, group }) {
    return {
      id: ext.id,
      name: ext.short ?? ext.name,
      group,
      status: statusOf(ext),
      version: ext.version ?? null,
      ratification_date: ext.ratification_date ?? null,
    };
  }

  // -------------------------------------------------------------------------

  function about() {
    return {
      name: 'RISC-V ISA Explorer',
      site: SITE_URL,
      data_version: x.dataVersion,
      extensions: extensions.length,
      instructions: instructions.size,
      profiles: profileNames,
      base_isas: [...x.BASE_ISA_IDS],
      sources:
        'Extension metadata and dependencies are synced from riscv-unified-db; instruction ' +
        'encodings from riscv-opcodes; profiles are transcribed from the profile specifications. ' +
        'Every dependency edge cites udb, isa-manual or clang, and generated -march strings are ' +
        'validated against clang in CI.',
    };
  }

  function listExtensions({ query, status, group, limit = 50 } = {}) {
    let hits = extensions;
    if (query) {
      const q = query.toLowerCase();
      hits = hits.filter(({ ext }) =>
        [ext.id, ext.name, ext.short, ext.long_name, ext.desc, ext.use]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(q)),
      );
    }
    if (status) hits = hits.filter(({ ext }) => statusOf(ext) === status);
    if (group) {
      const g = group.toLowerCase();
      hits = hits.filter((e) => e.group.toLowerCase().includes(g));
    }
    return {
      total: hits.length,
      returned: Math.min(hits.length, limit),
      extensions: hits.slice(0, limit).map(summary),
      groups: x.CATALOGUE_GROUPS.map((g) => g.label),
    };
  }

  function getExtension({ id, include_instructions = false }) {
    const entry = findExtension(id);
    const { ext } = entry;
    const node = nodes[ext.id] ?? {};
    const instructionNames = Object.keys(ext.instructions ?? {});
    const requiredBy = Object.entries(nodes)
      .filter(([, n]) => (n.requires ?? []).some((e) => e.ext === ext.id))
      .map(([other]) => other)
      .sort();
    return {
      ...summary(entry),
      long_name: ext.long_name ?? null,
      description: ext.desc,
      use: ext.use,
      spec_url: ext.url ?? null,
      explorer_url: extensionPage(ext.id),
      ...(ext.members ? { members: ext.members } : {}),
      requires: (node.requires ?? []).map((e) => ({ ext: e.ext, source: e.src, ref: e.ref ?? '' })),
      ...(node.requiresOneOf ? { requires_one_of: node.requiresOneOf } : {}),
      ...(node.conflicts ? { conflicts: node.conflicts } : {}),
      ...(node.params ? { params: node.params } : {}),
      implies_transitively: [...x.closure(ext.id)].sort(),
      required_by: requiredBy,
      profiles: profilesContaining(ext.id),
      instruction_count: instructionNames.length,
      ...(include_instructions ? { instructions: instructionNames } : {}),
      ...(ext.csrs ? { csrs: Object.keys(ext.csrs) } : {}),
    };
  }

  function resolveConfiguration({ base, extensions: picked = [] }) {
    const baseId = findBase(base);
    const unknownIds = [];
    const ids = [];
    for (const id of picked) {
      const hit = byId.get(String(id).trim().toLowerCase());
      if (hit) ids.push(hit.ext.id);
      else unknownIds.push(id);
    }
    const result = x.resolveSelection({ selected: [baseId, ...ids], base: baseId });
    const built = marchFor(result.resolved);
    const unknown = [
      ...unknownIds.map((ext) => ({
        ext,
        from: null,
        suggestions: suggest(String(ext), [...catalogIds]),
      })),
      ...result.unknown,
    ];
    return {
      base: baseId,
      selected: ids,
      valid: result.conflicts.length === 0 && unknown.length === 0 && Boolean(built.march),
      march: built.march,
      ...(built.excluded.length ? { excluded_from_march: built.excluded } : {}),
      ...(built.warnings.length ? { warnings: built.warnings } : {}),
      resolved: [...result.resolved].sort(),
      implied: result.implied.map(({ ext, path }) => ({ ext, path, because: citedPath(path) })),
      redundant: result.redundant,
      conflicts: result.conflicts,
      choices: result.choices,
      unknown,
      params: x.resolveParams(result.resolved),
    };
  }

  function parseMarch({ march }) {
    if (typeof march !== 'string' || !march.trim())
      throw new ToolInputError('A -march string is required.');
    const parsed = x.parseMarchString(march, flatCatalog);
    const base = parsed.resolvedIds.find((id) => x.BASE_ISA_IDS.has(id)) ?? null;
    const named = parsed.resolvedIds.filter((id) => !x.BASE_ISA_IDS.has(id));
    const out = {
      input: march,
      xlen: parsed.xlen,
      base,
      extensions: named,
      unknown_tokens: parsed.unknownTokens,
      warnings: parsed.warnings,
    };
    if (!base) return out;
    const result = x.resolveSelection({ selected: parsed.resolvedIds, base });
    const given = new Set(parsed.resolvedIds);
    return {
      ...out,
      canonical_march: marchFor(result.resolved).march,
      implied_but_not_written: result.implied
        .filter(({ ext }) => !given.has(ext))
        .map(({ ext, path }) => ({ ext, path })),
      conflicts: result.conflicts,
    };
  }

  function explainDependency({ extension, requires }) {
    const from = findExtension(extension).ext.id;
    const to = findExtension(requires).ext.id;
    const result = x.resolveSelection({ selected: [from] });
    const hit = result.implied.find((entry) => entry.ext === to);
    if (hit) {
      return {
        extension: from,
        requires: to,
        answer: true,
        path: hit.path,
        because: citedPath(hit.path),
      };
    }
    const reverse = x.closure(to).has(from);
    return {
      extension: from,
      requires: to,
      answer: false,
      explanation:
        `${from} does not require ${to}.` +
        (reverse ? ` The reverse holds: ${to} requires ${from}.` : ''),
    };
  }

  function listProfiles() {
    return {
      profiles: profileNames.map((profile) => ({
        profile,
        ...x.PROFILE_METADATA[profile],
        mandatory_count: x.PROFILES[profile].length,
        optional_count: (x.profileOptional[profile] ?? []).length,
      })),
    };
  }

  function getProfile({ profile, include_implied = true }) {
    const name = findProfile(profile);
    const membership = membershipOf(name, include_implied);
    const rows = x.profileExtensionRows({
      membership,
      catalog: x.catalog,
      groups: x.CATALOGUE_GROUPS,
    });
    const members = x.PROFILES[name];
    const base = members.find((id) => x.BASE_ISA_IDS.has(id)) ?? null;
    const resolved = x.resolveSelection({ selected: members, base }).resolved;
    const counts = { mandatory: 0, implied: 0, optional: 0 };
    for (const row of rows) counts[row.requirement] += 1;
    return {
      profile: name,
      ...x.PROFILE_METADATA[name],
      march: marchFor(resolved).march,
      counts,
      extensions: rows.map(({ description: _d, ...row }) => row),
      explorer_url: SITE_URL,
    };
  }

  function compareProfiles({ profiles, include_implied = true, differences_only = false }) {
    const names = [...new Set(profiles.map(findProfile))];
    if (names.length < 2) throw new ToolInputError('Name at least two different profiles.');
    const memberships = names.map((p) => membershipOf(p, include_implied));
    const ids = [...new Set(memberships.flatMap((m) => [...m.keys()]))].sort((a, b) =>
      a.localeCompare(b),
    );
    let rows = ids.map((id) => {
      const row = { id };
      for (const [i, name] of names.entries())
        row[name] = memberships[i].get(id)?.requirement ?? null;
      return row;
    });
    const differs = (row) => new Set(names.map((n) => row[n])).size > 1;
    const differing = rows.filter(differs).length;
    if (differences_only) rows = rows.filter(differs);
    const onlyIn = Object.fromEntries(
      names.map((name, i) => [
        name,
        ids.filter(
          (id) => memberships[i].has(id) && memberships.every((m, j) => j === i || !m.has(id)),
        ),
      ]),
    );
    return {
      profiles: names,
      include_implied,
      legend:
        'Each cell is mandatory, implied (required by a mandatory extension), optional, or null (not in the profile).',
      extensions_compared: ids.length,
      differing,
      only_in: onlyIn,
      rows,
    };
  }

  const normalizeMnemonic = (m) =>
    String(m ?? '')
      .trim()
      .toUpperCase()
      .replace(/_/g, '.');

  function instructionView(mnemonic) {
    const listed = instructions.get(mnemonic);
    const { details } = listed[0];
    const meta = x.instructionMetadata[mnemonic.toLowerCase()];
    return {
      mnemonic,
      long_name: meta?.long_name ?? null,
      synopsis: meta ? x.instructionSynopsis(meta.description) || null : null,
      encoding: details.encoding,
      match: details.match,
      mask: details.mask,
      variable_fields: details.variable_fields ?? [],
      opcode_tags: details.extension ?? [],
      extensions: [...new Set(listed.map((l) => l.extId))],
      ...(meta?.source ? { source: meta.source } : {}),
    };
  }

  function lookupInstruction({ mnemonic }) {
    const key = normalizeMnemonic(mnemonic);
    if (!key) throw new ToolInputError('A mnemonic is required.');
    if (!instructions.has(key)) {
      const close = suggest(key, [...instructions.keys()], 8);
      throw new ToolInputError(
        `No instruction "${mnemonic}".` +
          (close.length ? ` Did you mean: ${close.join(', ')}?` : ''),
      );
    }
    return instructionView(key);
  }

  function decodeInstruction({ word }) {
    const text = String(word ?? '')
      .trim()
      .replace(/_/g, '');
    let value = null;
    if (/^0b[01]+$/i.test(text)) value = BigInt(text);
    else if (/^\d+$/.test(text)) value = BigInt(text);
    else value = x.parseHexToBigInt(text);
    if (value === null || value < 0n || value > 0xffffffffn) {
      throw new ToolInputError(
        `"${word}" is not a 32-bit instruction word. Pass hex (0x00b50533), binary (0b...) or decimal.`,
      );
    }
    const compressed = (value & 3n) !== 3n;
    const matches = patterns.filter(
      ({ match, mask }) => match !== null && mask !== null && (value & mask) === match,
    );
    // Most fixed bits first: a pseudo-op or a specific form is the better reading.
    const bits = (m) => m.toString(2).replace(/0/g, '').length;
    matches.sort((a, b) => bits(b.mask) - bits(a.mask) || a.mnemonic.localeCompare(b.mnemonic));
    return {
      word: compressed ? `0x${(value & 0xffffn).toString(16).padStart(4, '0')}` : x.toHex32(value),
      length: compressed ? 16 : 32,
      ...(compressed && value > 0xffffn
        ? {
            note: 'The low two bits are not 11, so only the low 16 bits form a compressed instruction.',
          }
        : {}),
      matches: matches.map(({ mnemonic }) => instructionView(mnemonic)),
      ...(matches.length > 1
        ? {
            ambiguity:
              'Several encodings match. Compare opcode_tags: rv32_*/rv64_* tags mean the form exists only for that XLEN.',
          }
        : {}),
    };
  }

  return {
    about,
    listExtensions,
    getExtension,
    resolveConfiguration,
    parseMarch,
    explainDependency,
    listProfiles,
    getProfile,
    compareProfiles,
    lookupInstruction,
    decodeInstruction,
  };
}
