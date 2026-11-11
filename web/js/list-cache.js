const LIST_CACHE_PREFIX = 'apeek_list_cache_v2:';

function isQuotaError(error) {
  return error && (
    error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 22
    || error.code === 1014
  );
}

export function clearListCaches() {
  try {
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var key = localStorage.key(i);
      if (key && key.indexOf(LIST_CACHE_PREFIX) === 0) localStorage.removeItem(key);
    }
  } catch (e) {}
}

export function readListCache(key) {
  try {
    return JSON.parse(localStorage.getItem(LIST_CACHE_PREFIX + key) || 'null');
  } catch (e) {
    return null;
  }
}

export function writeListCache(key, data) {
  var storageKey = LIST_CACHE_PREFIX + key;
  var serialized;
  try {
    serialized = JSON.stringify(data);
    localStorage.setItem(storageKey, serialized);
    return true;
  } catch (e) {
    if (!isQuotaError(e) || serialized === undefined) return false;
  }

  clearListCaches();
  try {
    localStorage.setItem(storageKey, serialized);
    return true;
  } catch (e) {
    return false;
  }
}

export function invalidateListCache(key) {
  try {
    localStorage.removeItem(LIST_CACHE_PREFIX + key);
  } catch (e) {}
}
