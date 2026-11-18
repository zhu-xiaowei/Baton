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

  return {
    render: function (items) {
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
      requestAnimationFrame(function () {
        if (!scroll) return;
        // Ancestors of the anchor stay reachable by scrolling left; a spacer lets the anchor start the row.
        var item = anchor > 0 && scroll.querySelectorAll('.path-breadcrumb-item')[anchor];
        if (item) {
          var gap = item.getBoundingClientRect().left - scroll.getBoundingClientRect().left
            - (scroll.scrollWidth - scroll.clientWidth);
          if (gap > 0) {
            var spacer = document.createElement('span');
            spacer.style.cssText = 'display:inline-block;width:' + gap + 'px';
            scroll.appendChild(spacer);
          }
        }
        scroll.scrollLeft = scroll.scrollWidth;
      });
    },
    setLoading: function (loading) {
      setBreadcrumbItemsLoading(
        container.querySelectorAll('.path-breadcrumb-item'),
        loading,
      );
    },
    destroy: function () {
      resetBreadcrumbItems(container.querySelectorAll('.path-breadcrumb-item'));
      container.removeEventListener('click', handleClick);
      container.innerHTML = '';
    },
  };
}
