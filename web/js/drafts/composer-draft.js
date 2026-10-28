import { state } from '../state.js';
import {
  createComposerDraftController,
  createComposerDraftStore,
} from './composer-draft-core.js';
import {
  createIndexedDbComposerDraftBackend,
} from './composer-draft-idb.js';

const store = createComposerDraftStore(createIndexedDbComposerDraftBackend());
var initialized = false;

function inputElement() {
  return document.getElementById('msg-input');
}

// Only uploaded attachments are drafted: their key sends them, and dataUrl previews images.
function readAttachments() {
  return state.stagedImages.filter(function (entry) {
    return entry.uploaded && entry.key;
  }).map(function (entry) {
    return entry.kind === 'file'
      ? { kind: 'file', name: entry.name, key: entry.key }
      : { name: entry.name, key: entry.key, dataUrl: entry.dataUrl };
  });
}

function applyAttachments(attachments) {
  state.stagedImages.forEach(function (entry) { entry.controller?.abort(); });
  state.stagedImages = (attachments || []).map(function (item) {
    return Object.assign({}, item, { uploaded: true });
  });
  window.renderStagedImages?.();
}

function applyInput(text, attachments) {
  var input = inputElement();
  if (!input) return;
  input.value = text;
  input.style.height = 'auto';
  if (text) input.style.height = input.scrollHeight + 'px';
  applyAttachments(attachments);
  var EventConstructor = input.ownerDocument?.defaultView?.Event || globalThis.Event;
  input.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  if (typeof window.updateSendBtn === 'function') {
    window.updateSendBtn({ skipSpinner: true });
  }
}

function draftFields(sessionId) {
  return {
    server: state.SERVER || '',
    device: state.appState.device || '',
    projectHash: state.appState.project?.hash || '',
    sessionId: sessionId || '',
  };
}

const controller = createComposerDraftController(store, {
  readInput: function () {
    var attachments = readAttachments();
    return {
      text: inputElement()?.value || '',
      attachments: attachments,
      pending: state.stagedImages.length > attachments.length,
    };
  },
  applyInput: applyInput,
});

export function initComposerDrafts() {
  if (initialized) return;
  initialized = true;
  var input = inputElement();
  if (input) input.addEventListener('input', controller.sync);
  window.addEventListener('pagehide', controller.flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') controller.flush();
  });
}

export function activateComposerDraft(sessionId, options) {
  return controller.activate(draftFields(sessionId), options).catch(function () {
    return null;
  });
}

export function clearComposerDraft() {
  return controller.clear().catch(function () {});
}

export function deactivateComposerDraft(options) {
  return controller.deactivate(options).catch(function () {});
}

export function flushComposerDraft() {
  return controller.flush().catch(function () {});
}

export function rekeyComposerDraft(sessionId) {
  return controller.rekey(draftFields(sessionId)).catch(function () {});
}

export function syncComposerDraft() {
  controller.sync();
}
