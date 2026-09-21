/**
 * Build-time feature flags.
 *
 * CommonJS on purpose, and at the repository root rather than in src/: both
 * halves of a user-facing feature can live on either side of the bundle
 * boundary, and webpack.config.js has to be able to require this file to gate
 * the HTML template. One switch, read by the config and by the bundle, so the
 * two cannot drift into a state where the UI is hidden but the vendor script
 * still loads.
 */
module.exports = {
  /**
   * The "Ask AI" assistant: the kapa.ai widget script in public/index.html and
   * the draggable launcher chip rendered by src/AskAiLauncher.jsx.
   *
   * Turned off on 2026-09-21 because the vendor is not cleared for use yet.
   * Off means off end to end: the launcher does not render AND the widget
   * script is left out of the emitted index.html, so no third-party code is
   * fetched or executed on the page.
   *
   * To turn it back on: set this to true and rebuild. Nothing else needs
   * touching - the widget markup, the launcher, its styles and the
   * context-aware question it opens with are all still in the tree.
   */
  AI_ASSISTANT_ENABLED: false,
};
