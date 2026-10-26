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
   * Off from 2026-09-21 to 2026-10-26 while the vendor was being cleared.
   * Off means off end to end: the launcher does not render AND the widget
   * script is left out of the emitted index.html, so no third-party code is
   * fetched or executed on the page.
   *
   * To turn it off again: set this to false and rebuild. Nothing else needs
   * touching. kapa answers only on domains in its dashboard allowlist, so a
   * host missing from it shows the launcher but fails every question.
   */
  AI_ASSISTANT_ENABLED: true,
};
