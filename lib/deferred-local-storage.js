export function deferredLocalStorageInit({ data }) {
  try {
    const entries = data[location.origin];
    if (!entries) return;
    for (const entry of entries) {
      if (entry && typeof entry.name === 'string' && localStorage.getItem(entry.name) === null) {
        localStorage.setItem(entry.name, String(entry.value ?? ''));
      }
    }
  } catch (_) {
    // Some origins or pages may deny storage access; cookies remain restored.
  }
}

export async function installDeferredLocalStorage(context, data) {
  if (!context || !data || Object.keys(data).length === 0) return false;
  await context.addInitScript(deferredLocalStorageInit, { data });
  return true;
}
