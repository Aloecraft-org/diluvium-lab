// HTML escaping, in one place.
//
// Both the markdown renderer and the syntax highlighter build HTML from
// text that arrives in notebook files, so both need this and neither may
// skip it. Sharing it is not only about duplication -- two subtly different
// escape tables is how one of them ends up missing a character.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape for both text content and attribute values. Quotes are escaped
 * even where text content would not need them: the cost is nothing, and it
 * means a caller who moves a string into an attribute cannot introduce a
 * hole by forgetting which variant they had.
 */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
