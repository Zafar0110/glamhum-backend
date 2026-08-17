// Readable artist URLs: /explore/zafar-iqbal-hevanef820 instead of a UUID.
//
// The username is appended because two artists can share a name — the local
// database already has two "Zafar Iqbal" accounts. Usernames are unique, so a
// slug built from one is unique too.

/** "Zafar Iqbal!" -> "zafar-iqbal". Latin letters, digits and hyphens only. */
function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    // Strip accents so "Simeunović" becomes "simeunovic" rather than vanishing.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The slug for one artist. Falls back to the username alone when the name is
 * empty or unslugifiable (for example a name written entirely in Arabic).
 */
function buildArtistSlug({ firstName, lastName, username }) {
  const name = slugify([firstName, lastName].filter(Boolean).join(' '))
  const handle = slugify(username)

  if (!handle) return name || null
  return name ? `${name}-${handle}` : handle
}

/** A slug is anything that is not a bare UUID, which is how ids look. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function looksLikeUuid(value) {
  return UUID_PATTERN.test(String(value || '').trim())
}

module.exports = { slugify, buildArtistSlug, looksLikeUuid }
