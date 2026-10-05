/**
 * Unified-db descriptions are AsciiDoc source, not plain UI copy. Keep the
 * catalogue's concise lead paragraph and remove common inline formatting;
 * tables, conditional templates, and the rest of the full specification stay
 * available through the pinned source link.
 */
export function instructionSynopsis(description) {
  if (typeof description !== 'string') return '';

  const lead = description
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .find((paragraph) => paragraph && !/^(?:<%-|\[%|\|===|\[={1,2})/.test(paragraph));

  if (!lead) return '';

  return lead
    // Correct this confirmed upstream grammar typo in the user-facing synopsis.
    .replace(/^Can causes\b/, 'Can cause')
    .split(/\s+\[(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i)[0]
    .replace(/<%[\s\S]*?%>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
