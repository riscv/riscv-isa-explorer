/*
 * The details panel's "where is the specification" button. 177 extensions
 * link a chapter on docs.riscv.org; the rest, mostly proposals not yet
 * published, link the ISA manual's sources on GitHub, sometimes only the
 * repository root. The label says which, so a reader expecting a rendered
 * chapter is not surprised by an AsciiDoc tree.
 */
const ISA_MANUAL = 'https://github.com/riscv/riscv-isa-manual';

export function specificationLink(url) {
  const target = url || ISA_MANUAL;
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return { url: target, label: 'Specification' };
  }
  if (parsed.hostname === 'github.com') {
    const repoRoot = parsed.pathname.replace(/\/+$/, '').split('/').length <= 3;
    return {
      url: target,
      label: repoRoot ? 'ISA manual source on GitHub' : 'Specification source on GitHub',
    };
  }
  return { url: target, label: `Read Online at ${parsed.hostname}` };
}
