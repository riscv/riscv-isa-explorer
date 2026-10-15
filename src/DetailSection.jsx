import React from 'react';

/**
 * One titled section of the instruction details: a bordered box with a real
 * heading, so the card reads as "Write it", "Encoding", "Implementations and
 * tests" instead of a run of identical small labels, and a screen reader can
 * jump between sections by heading.
 *
 * `id` is the anchor the card's "Jump to" links focus; the section takes focus
 * itself (tabIndex -1) so the jump also moves a keyboard or screen-reader user
 * there, not just the scroll position.
 */
export default function DetailSection({ id, icon: Icon, title, children }) {
  const headingId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      tabIndex={-1}
      className="riscv-detail-section rounded-md p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
    >
      <h4
        id={headingId}
        className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--riscv-text)' }}
      >
        {Icon && <Icon size={13} aria-hidden="true" style={{ color: 'var(--riscv-violet)' }} />}
        {title}
      </h4>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
