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
      // Placed again whenever the row's width changes (a panel opening or docking, a window resize).
      function place() {
        if (!scroll || !scroll.clientWidth) return; // not laid out yet
        var spacer = scroll.querySelector('.path-breadcrumb-spacer');
        if (spacer) spacer.remove();
        var items = scroll.querySelectorAll('.path-breadcrumb-item');
        var item = anchor > 0 && items[anchor];
        var gap = item ? scroll.clientWidth - (items[items.length - 1].getBoundingClientRect().right - item.getBoundingClientRect().left) : 0;
        if (gap > 0) {
          spacer = document.createElement('span');
          spacer.className = 'path-breadcrumb-spacer';
          spacer.style.cssText = 'display:inline-block;width:' + gap + 'px';
          scroll.appendChild(spacer);
        }
        scroll.scrollLeft = scroll.scrollWidth;
      }
      if (typeof ResizeObserver === 'function' && scroll) {
        observer = new ResizeObserver(place);
        observer.observe(scroll);
      } else requestAnimationFrame(place);
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
