export function composerDraftKey(fields) {
  return JSON.stringify([
    fields.server || '',
    fields.device || '',
    fields.projectHash || '',
    fields.sessionId || '',
  ]);
}

// Input reads may return plain text or { text, attachments }.
function normalizeDraft(value) {
  if (value && typeof value === 'object') {
    return {
      text: String(value.text || ''),
      attachments: Array.isArray(value.attachments) ? value.attachments : [],
    };
  }
  return { text: String(value || ''), attachments: [] };
}

function isEmptyDraft(draft) {
  return !draft.text && !draft.attachments.length;
}

// Attachment keys identify content, so comparing them avoids serializing image data.
function draftSignature(draft) {
  if (!draft.attachments.length) return draft.text;
  return draft.text + '\0' + draft.attachments.map(function (item) { return item.key; }).join('\0');
}

export function createComposerDraftStore(backend, options) {
  options = options || {};
  var now = options.now || Date.now;

  async function get(fields) {
    return backend.get(composerDraftKey(fields));
  }

  async function put(fields, value) {
    var draft = normalizeDraft(value);
    var record = {
      key: composerDraftKey(fields),
      server: fields.server || '',
      device: fields.device || '',
      projectHash: fields.projectHash || '',
      sessionId: fields.sessionId || '',
      text: draft.text,
      updatedAt: now(),
    };
    if (draft.attachments.length) record.attachments = draft.attachments;
    await backend.put(record);
    return record;
  }

  function remove(fields) {
    return backend.delete(composerDraftKey(fields));
  }

  return {
    get: get,
    put: put,
    delete: remove,
  };
}

export function createComposerDraftController(store, options) {
  options = options || {};
  var readInput = options.readInput;
  var applyInput = options.applyInput;
  var schedule = options.schedule || setTimeout;
  var cancel = options.cancel || clearTimeout;
  var debounceMs = options.debounceMs == null ? 180 : options.debounceMs;
  var activeFields = null;
  var activeKey = '';
  var lastText = '';
  var timer = null;
  var generation = 0;
  var writeChain = Promise.resolve();

  function enqueue(operation) {
    var result = writeChain.then(operation);
    writeChain = result.catch(function () {});
    return result;
  }

  function persist(fields, draft) {
    if (!fields || !fields.sessionId) return Promise.resolve();
    return enqueue(function () {
      return isEmptyDraft(draft) ? store.delete(fields) : store.put(fields, draft);
    });
  }

  function cancelScheduledWrite() {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  }

  function captureNow() {
    cancelScheduledWrite();
    if (!activeFields) return writeChain;
    var fields = activeFields;
    var draft = normalizeDraft(readInput());
    lastText = draftSignature(draft);
    return persist(fields, draft);
  }

  function sync() {
    if (!activeFields) return;
    var draft = normalizeDraft(readInput());
    var signature = draftSignature(draft);
    if (signature === lastText) return;
    lastText = signature;
    cancelScheduledWrite();
    var fields = activeFields;
    timer = schedule(function () {
      timer = null;
      persist(fields, draft);
    }, debounceMs);
  }

  async function activate(fields, activateOptions) {
    activateOptions = activateOptions || {};
    var restore = activateOptions.restore !== false;
    var previousSave = captureNow();
    var nextFields = Object.assign({}, fields);
    var nextKey = composerDraftKey(nextFields);
    var activation = ++generation;
    activeFields = nextFields;
    activeKey = nextKey;
    lastText = '';
    applyInput('', []);
    if (!restore || !nextFields.sessionId) return null;

    await previousSave.catch(function () {});
    var record = await store.get(nextFields).catch(function () { return null; });
    if (activation !== generation || activeKey !== nextKey) return null;
    var current = readInput();
    if (lastText || current?.pending || !isEmptyDraft(normalizeDraft(current))) return null;
    if (!record) return null;
    var draft = normalizeDraft(record);
    if (isEmptyDraft(draft)) return null;
    lastText = draftSignature(draft);
    applyInput(draft.text, draft.attachments);
    return record;
  }

  function clear() {
    cancelScheduledWrite();
    if (!activeFields) return Promise.resolve();
    lastText = '';
    return persist(activeFields, normalizeDraft(''));
  }

  function deactivate(deactivateOptions) {
    deactivateOptions = deactivateOptions || {};
    var saved = captureNow();
    generation++;
    activeFields = null;
    activeKey = '';
    lastText = '';
    if (deactivateOptions.clearInput !== false) applyInput('', []);
    return saved;
  }

  function rekey(fields) {
    cancelScheduledWrite();
    var oldFields = activeFields;
    var nextFields = Object.assign({}, fields);
    var nextKey = composerDraftKey(nextFields);
    var draft = normalizeDraft(readInput());
    generation++;
    activeFields = nextFields;
    activeKey = nextKey;
    lastText = draftSignature(draft);
    return enqueue(async function () {
      if (oldFields && composerDraftKey(oldFields) !== nextKey) {
        await store.delete(oldFields);
      }
      if (isEmptyDraft(draft)) await store.delete(nextFields);
      else await store.put(nextFields, draft);
    });
  }

  return {
    activate: activate,
    clear: clear,
    deactivate: deactivate,
    flush: captureNow,
    rekey: rekey,
    sync: sync,
  };
}
