function escapeAttribute(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function loadingSpinner(options) {
  options = options || {};
  var size = options.size === 'small' ? 'small' : 'medium';
  var label = options.label || 'Loading';
  return '<span class="loading-spinner loading-spinner-' + size + '"'
    + ' role="status" aria-label="' + escapeAttribute(label) + '"></span>';
}

export function setButtonLoading(button, label) {
  if (!button) return;
  if (label) {
    if (!button.hasAttribute('aria-busy')) button.dataset.origText = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    button.replaceChildren(spinner, document.createTextNode(label));
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.origText) button.textContent = button.dataset.origText;
    delete button.dataset.origText;
  }
}
