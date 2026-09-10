const ALIAS = /^[a-z][a-z0-9_-]{0,63}$/;
const USER_ID = /^hermes_camofox_[0-9a-f]{24}$/;

function displayName(alias) {
  return alias.split(/[-_]/).filter(Boolean)
    .map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Safe, configuration-derived metadata for native launchers. */
export function sharedIdentityMetadata(aliases) {
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return [];
  const seen = new Set();
  const identities = [];
  for (const [alias, userId] of Object.entries(aliases)) {
    if (!ALIAS.test(alias) || typeof userId !== 'string' || !USER_ID.test(userId) || seen.has(userId)) continue;
    seen.add(userId);
    identities.push({ alias, userId, displayName: displayName(alias) });
  }
  return identities.sort((left, right) => left.alias.localeCompare(right.alias));
}
