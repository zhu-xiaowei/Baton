import { backButtonHtml } from './back-button.js';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

var loadingEndTimers = new WeakMap();

function clearLoadingTimer(item) {
  var timer = loadingEndTimers.get(item);
  if (timer) clearTimeout(timer);
  loadingEndTimers.delete(item);
}

function resetBreadcrumbItems(items) {
  Array.from(items || []).forEach(function (item) {
    clearLoadingTimer(item);
    item.classList.remove('is-loading', 'is-loading-ending');
    item.removeAttribute('aria-busy');
  });
}

export function setBreadcrumbItemsLoading(items, loading) {
  var list = Array.from(items || []);
  if (loading) {
    resetBreadcrumbItems(list);
    var current = list[list.length - 1];
    if (current) {
      current.classList.add('is-loading');
      current.setAttribute('aria-busy', 'true');
    }
    return;
  }

  var current = list.find(function (item) {
    return item.classList.contains('is-loading');
  });
  if (!current) return;
  clearLoadingTimer(current);
  current.classList.add('is-loading-ending');
  current.removeAttribute('aria-busy');
  loadingEndTimers.set(current, setTimeout(function () {
    current.classList.remove('is-loading', 'is-loading-ending');
    loadingEndTimers.delete(current);
  }, 220));
}

export function createBreadcrumb(container, options) {
  options = options || {};
  var onBack = options.onBack;
  var onNavigate = options.onNavigate;

  function handleClick(event) {
    var back = event.target.closest('.path-breadcrumb-back');
    if (back) {
      if (typeof onBack === 'function') onBack();
      return;
    }
    var item = event.target.closest('.path-breadcrumb-item');
    if (item && typeof onNavigate === 'function') {
      onNavigate(item.dataset.value || '');
    }
  }

  container.addEventListener('click', handleClick);
  var observer;

  return {
    render: function (items) {
      if (observer) observer.disconnect();
      resetBreadcrumbItems(container.querySelectorAll('.path-breadcrumb-item'));
      container.innerHTML = backButtonHtml({ className: 'path-breadcrumb-back' })
        + '<div class="path-breadcrumb-scroll">'
        + (items || []).map(function (item, index) {
          return (index && !items[index - 1].root ? '<span class="path-breadcrumb-separator">/</span>' : '')
            + '<button class="path-breadcrumb-item" type="button" data-value="'
            + escapeHtml(item.value || '') + '">' + escapeHtml(item.label) + '</button>';
        }).join('')
        + '</div>';
      var scroll = container.querySelector('.path-breadcrumb-scroll');
      var anchor = (items || []).findIndex(function (item) { return item.anchor; });
      // Ancestors of the anchor stay reachable by scrolling left; a spacer lets the anchor start the row.
      function place() {
        if (!scroll.clientWidth) return false; // not laid out yet (hidden panel): wait for a size
        var items = scroll.querySelectorAll('.path-breadcrumb-item');
        var item = anchor > 0 && items[anchor];
        if (item) {
          // Room after the anchor so that scrolling to the end leaves the anchor first in the row.
          var gap = scroll.clientWidth - (items[items.length - 1].getBoundingClientRect().right - item.getBoundingClientRect().left);
          if (gap > 0) {
            var spacer = document.createElement('span');
            spacer.style.cssText = 'display:inline-block;width:' + gap + 'px';
            scroll.appendChild(spacer);
          }
        }
        scroll.scrollLeft = scroll.scrollWidth;
        return true;
      }
      requestAnimationFrame(function () {
        if (!scroll || place() || typeof ResizeObserver !== 'function') return;
        observer = new ResizeObserver(function () { if (place()) observer.disconnect(); });
        observer.observe(scroll);
      });
    },
    setLoading: function (loading) {
      setBreadcrumbItemsLoading(
        container.querySelectorAll('.path-breadcrumb-item'),
        loading,
      );
    },
    destroy: function () {
      if (observer) observer.disconnect();
      resetBreadcrumbItems(container.querySelectorAll('.path-breadcrumb-item'));
      container.removeEventListener('click', handleClick);
      container.innerHTML = '';
    },
  };
}
