import { hideCenteredModal, showCenteredModal } from '../components/modal-viewport.js';
import { setButtonLoading } from '../components/loading.js';
import { requestGit } from './rpc.js';

const WRITE_TIMEOUT = 120000;
const MAX_LINES = 4;
const MAX_MESSAGE_BYTES = 16 * 1024;

var bar = null;
var input = null;
var action = null;
var errorEl = null;
var options = {};
var snapshot = null;
var mode = 'hidden';
var busy = false;
var drafts = new Map();

function esc(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

// hidden | commit | push | publish, derived only from the latest status snapshot.
function modeFor(value) {
  var repository = value?.repository;
  var capabilities = value?.capabilities || {};
  if (!repository || repository.detached) return 'hidden';
  if (capabilities.commit === 1 && value.groups?.staged?.length) return 'commit';
  if (capabilities.push !== 1 || repository.unborn) return 'hidden';
  if (!repository.upstream) return 'publish';
  return repository.ahead ? 'push' : 'hidden';
}

function autosize() {
  var style = getComputedStyle(input);
  var borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  var padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  var line = parseFloat(style.lineHeight) || 20;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight + borders, line * MAX_LINES + padding + borders) + 'px';
}

function setError(message) {
  errorEl.textContent = message || '';
  errorEl.hidden = !message;
}

function render() {
  if (!bar) return;
  bar.hidden = mode === 'hidden';
  input.hidden = mode !== 'commit';
  if (busy) return;
  var repository = snapshot?.repository || {};
  var staged = snapshot?.groups?.staged?.length || 0;
  var conflicts = snapshot?.groups?.conflicts?.length || 0;
  action.className = 'git-commit-action git-commit-action-' + mode;
  if (mode === 'commit') {
    action.textContent = 'Commit ' + plural(staged, 'file');
    action.disabled = conflicts > 0 || !input.value.trim();
    input.placeholder = 'Message (commit to ' + (repository.branch || 'HEAD') + ')';
  } else if (mode === 'push') {
    action.textContent = '↑ Push ' + plural(repository.ahead, 'commit');
    action.disabled = false;
  } else if (mode === 'publish') {
    action.textContent = 'Publish ' + (repository.branch || 'branch');
    action.disabled = false;
  }
}

function applyResult(result) {
  if (result?.groups) options.onSnapshot?.(result);
}

async function commit() {
  var message = input.value.trim();
  if (!message || busy) return;
  if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) {
    setError('Commit message is too long (max 16 KB).');
    return;
  }
  busy = true;
  setError('');
  input.disabled = true;
  setButtonLoading(action, 'Committing');
  try {
    var result = await requestGit('commit', {
      projectHash: options.projectHash,
      message: message,
      stagedId: snapshot?.stagedId,
    }, { timeout: WRITE_TIMEOUT });
    input.value = '';
    drafts.delete(options.projectKey);
    autosize();
    busy = false;
    applyResult(result);
  } catch (error) {
    busy = false;
    applyResult(error.response);
    setError(error.message || 'Commit failed.');
  } finally {
    input.disabled = false;
    setButtonLoading(action);
    render();
  }
}

function confirmPush() {
  var repository = snapshot?.repository || {};
  var publish = mode === 'publish';
  var target = publish ? 'origin/' + repository.branch : repository.upstream;
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay git-push-overlay';
    overlay.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true">'
      + '<div class="modal-title">' + (publish ? 'Publish branch?' : 'Push commits?') + '</div>'
      + '<div class="modal-desc">' + (publish
        ? 'Create <b>' + esc(target) + '</b> and push ' + esc(repository.branch) + ' to it.'
        : 'Push ' + plural(repository.ahead, 'commit') + ' to <b>' + esc(target) + '</b>.') + '</div>'
      + '<div class="modal-error" role="alert"></div><div class="modal-actions">'
      + '<button class="modal-btn cancel" type="button">Cancel</button>'
      + '<button class="modal-btn confirm" type="button">' + (publish ? 'Publish' : 'Push') + '</button>'
      + '</div></div>';
    var confirm = overlay.querySelector('.confirm');
    var cancel = overlay.querySelector('.cancel');
    var errorBox = overlay.querySelector('.modal-error');
    var running = false;
    function finish(value) {
      if (running) return;
      document.removeEventListener('keydown', onKey);
      hideCenteredModal(overlay);
      overlay.remove();
      resolve(value);
    }
    function onKey(event) { if (event.key === 'Escape') finish(false); }
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay || event.target.closest('.cancel')) finish(false);
    });
    confirm.addEventListener('click', async function () {
      if (running) return;
      running = true;
      errorBox.textContent = '';
      cancel.disabled = true;
      setButtonLoading(confirm, publish ? 'Publishing' : 'Pushing');
      try {
        applyResult(await requestGit('push', { projectHash: options.projectHash }, { timeout: WRITE_TIMEOUT }));
        running = false;
        options.onPushed?.();
        finish(true);
      } catch (error) {
        applyResult(error.response);
        errorBox.textContent = error.message || 'Push failed.';
      } finally {
        running = false;
        cancel.disabled = false;
        setButtonLoading(confirm);
      }
    });
    showCenteredModal(overlay);
    document.addEventListener('keydown', onKey);
    cancel.focus({ preventScroll: true });
  });
}

function ensureBar(container) {
  if (bar === container) return;
  bar = container;
  bar.innerHTML = '<textarea class="git-commit-input" rows="1" enterkeyhint="enter"'
    + ' aria-label="Commit message"></textarea>'
    + '<button class="git-commit-action" type="button"></button>'
    + '<div class="git-error git-commit-error" role="alert" hidden></div>';
  input = bar.querySelector('.git-commit-input');
  action = bar.querySelector('.git-commit-action');
  errorEl = bar.querySelector('.git-commit-error');
  input.addEventListener('input', function () {
    drafts.set(options.projectKey, input.value);
    autosize();
    render();
  });
  action.addEventListener('click', function () {
    if (mode === 'commit') commit();
    else if (mode === 'push' || mode === 'publish') confirmPush();
  });
}

export function mountCommitBar(next) {
  var projectChanged = options.projectKey !== next.projectKey;
  options = next;
  ensureBar(next.container);
  if (projectChanged) {
    input.value = drafts.get(next.projectKey) || '';
    setError('');
    snapshot = null;
    mode = 'hidden';
  }
  render();
}

export function updateCommitBar(value) {
  if (!bar) return;
  snapshot = value;
  var next = modeFor(value);
  if (next !== mode) setError('');
  mode = next;
  render();
  if (mode === 'commit') autosize();
}
