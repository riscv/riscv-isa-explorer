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

  return stripInlineFormatting(
    lead
      // Correct this confirmed upstream grammar typo in the user-facing synopsis.
      .replace(/^Can causes\b/, 'Can cause')
      .split(/\s+\[(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i)[0]
      .replace(/<%[\s\S]*?%>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Removes AsciiDoc's inline formatting (`code`, **strong**, *strong*,
 * _emphasis_), keeping the text it marks. Shared with the extension notes,
 * which show UDB's behavior text.
 */
export function stripInlineFormatting(text) {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}
