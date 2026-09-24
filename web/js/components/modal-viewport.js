const centeredModals = new WeakMap();

export function showCenteredModal(modal) {
  if (!modal) return;
  modal.style.display = 'flex';
  if (centeredModals.has(modal)) return;
  const parent = modal.parentNode;
  const nextSibling = modal.nextSibling;
  const viewport = window.visualViewport;
  const originalStyles = Object.fromEntries(
    ['top', 'left', 'width', 'height', 'right', 'bottom', 'fontFamily']
      .map(property => [property, modal.style[property]]),
  );
  let viewportFrame = null;
  function syncViewport() {
    viewportFrame = null;
    Object.assign(modal.style, {
      top: (viewport?.offsetTop || 0) + 'px',
      left: (viewport?.offsetLeft || 0) + 'px',
      width: (viewport?.width || window.innerWidth) + 'px',
      height: (viewport?.height || window.innerHeight) + 'px',
      right: 'auto',
      bottom: 'auto',
    });
  }
  function scheduleViewportSync() {
    if (viewportFrame === null) viewportFrame = requestAnimationFrame(syncViewport);
  }
  modal.style.fontFamily = window.getComputedStyle(modal.parentElement || document.body).fontFamily;
  modal.classList.add('viewport-centered-modal');
  document.documentElement.appendChild(modal);
  viewport?.addEventListener('resize', scheduleViewportSync);
  viewport?.addEventListener('scroll', scheduleViewportSync);
  window.addEventListener('resize', scheduleViewportSync);
  centeredModals.set(modal, function () {
    viewport?.removeEventListener('resize', scheduleViewportSync);
    viewport?.removeEventListener('scroll', scheduleViewportSync);
    window.removeEventListener('resize', scheduleViewportSync);
    if (viewportFrame !== null) cancelAnimationFrame(viewportFrame);
    Object.assign(modal.style, originalStyles);
    modal.classList.remove('viewport-centered-modal');
    if (parent) parent.insertBefore(modal, nextSibling?.parentNode === parent ? nextSibling : null);
    else modal.remove();
  });
  syncViewport();
}

export function hideCenteredModal(modal) {
  if (!modal) return;
  modal.style.display = 'none';
  centeredModals.get(modal)?.();
  centeredModals.delete(modal);
}
