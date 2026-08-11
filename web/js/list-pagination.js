export const LIST_PAGE_SIZE = 50;

export function mergeListItems(current, incoming, idKey) {
  var byId = new Map();
  current.forEach(function (item) { byId.set(item[idKey], item); });
  incoming.forEach(function (item) { byId.set(item[idKey], item); });
  return Array.from(byId.values()).sort(function (a, b) {
    var aTime = String(a.lastActive || '');
    var bTime = String(b.lastActive || '');
    if (aTime !== bTime) return aTime < bTime ? 1 : -1;
    var aId = String(a[idKey] || '');
    var bId = String(b[idKey] || '');
    return aId === bId ? 0 : (aId < bId ? 1 : -1);
  });
}

export function createListPageStore(maxEntries) {
  var entries = new Map();
  var max = maxEntries || 12;
  var nextRequestId = 0;

  function touch(key) {
    var entry = entries.get(key);
    if (!entry) {
      entry = {
        items: [],
        nextCursor: null,
        hasMore: false,
        loaded: false,
        loading: false,
        requestId: 0,
        scrollTop: 0,
      };
      entries.set(key, entry);
    } else {
      entries.delete(key);
      entries.set(key, entry);
    }
    while (entries.size > max) entries.delete(entries.keys().next().value);
    return entry;
  }

  function begin(key, force) {
    var entry = touch(key);
    if (entry.loading && !force) return null;
    entry.loading = true;
    entry.requestId = ++nextRequestId;
    return entry.requestId;
  }

  function finish(key, requestId) {
    var entry = entries.get(key);
    if (entry && entry.requestId === requestId) entry.loading = false;
  }

  function applyFirst(key, page, itemsKey, idKey, preserveLoaded) {
    var entry = touch(key);
    var incoming = Array.isArray(page && page[itemsKey]) ? page[itemsKey] : [];
    if (preserveLoaded && entry.loaded && page.hasMore) {
      entry.items = mergeListItems(entry.items, incoming, idKey);
    } else {
      entry.items = mergeListItems([], incoming, idKey);
      entry.nextCursor = page.nextCursor || null;
      entry.hasMore = !!page.hasMore && !!entry.nextCursor;
    }
    if (!page.hasMore) {
      entry.nextCursor = null;
      entry.hasMore = false;
    }
    entry.loaded = true;
    return entry;
  }

  function append(key, page, itemsKey, idKey) {
    var entry = touch(key);
    var incoming = Array.isArray(page && page[itemsKey]) ? page[itemsKey] : [];
    entry.items = mergeListItems(entry.items, incoming, idKey);
    entry.nextCursor = page.nextCursor || null;
    entry.hasMore = !!page.hasMore && !!entry.nextCursor;
    entry.loaded = true;
    return entry;
  }

  return {
    get: touch,
    peek: function (key) { return entries.get(key) || null; },
    begin: begin,
    finish: finish,
    applyFirst: applyFirst,
    append: append,
    rememberScroll: function (key, scrollTop) { touch(key).scrollTop = scrollTop || 0; },
    invalidate: function (key) { entries.delete(key); },
    clear: function () { entries.clear(); },
  };
}
