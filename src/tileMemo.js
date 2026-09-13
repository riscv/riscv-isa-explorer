/**
 * The memo comparator for ExtensionTile.
 *
 * Kept in a plain .js file, apart from the component, for two reasons. It is
 * pure logic rather than rendering, and node's test runner cannot import .jsx —
 * so living here is what makes the behaviour testable without pulling in a
 * transform or a DOM library.
 *
 * Why a custom comparator rather than React.memo's default shallow compare:
 * workspaceIds and lockedExtensions are rebuilt wholesale on every change, so a
 * shallow compare sees new objects and re-renders all 227 tiles whenever any one
 * of them moves. Asking instead "did membership change for THIS id" means
 * selecting D repaints the D tile and nothing else.
 *
 * The same principle applies to search: the tile is passed the ANSWER
 * (matchesSearch) rather than the question (searchQuery), so typing only
 * re-renders tiles whose match state changed.
 */

/** True when the tile can be skipped. */
export function tilePropsAreEqual(prev, next) {
  if (prev.data !== next.data) return false;
  if (prev.colorClass !== next.colorClass) return false;
  // A boolean, not the query string. Comparing the raw query meant every tile
  // failed this check on every keystroke, so all 219 re-rendered even though
  // only the handful whose match state actually flipped had anything new to
  // show. The parent computes the match once; the tile is told the answer.
  if (prev.matchesSearch !== next.matchesSearch) return false;
  if (prev.builderMode !== next.builderMode) return false;
  if (prev.compareMode !== next.compareMode) return false;
  if (prev.selectedExtId !== next.selectedExtId) return false;
  if (prev.onSelect !== next.onSelect) return false;
  if (prev.onToggleWorkspace !== next.onToggleWorkspace) return false;
  if (prev.onToggleCompare !== next.onToggleCompare) return false;
  if (prev.isHighlighted !== next.isHighlighted) return false;
  if (prev.isDimmed !== next.isDimmed) return false;

  // Per-tile membership, not container identity. This is the whole point.
  const id = next.data?.id;
  if (prev.workspaceIds.has(id) !== next.workspaceIds.has(id)) return false;
  if (prev.lockedExtensions.has(id) !== next.lockedExtensions.has(id)) return false;
  if (prev.compareIds.has(id) !== next.compareIds.has(id)) return false;

  // The tooltip names who requires this extension, so a change in the reason is
  // user-visible even when the locked flag itself has not moved.
  const prevLock = prev.lockedExtensions.get(id);
  const nextLock = next.lockedExtensions.get(id);
  if ((prevLock?.length ?? 0) !== (nextLock?.length ?? 0)) return false;

  return true;
}
