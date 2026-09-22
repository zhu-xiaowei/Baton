export function attachTerminalJoystick({ page, screen, canInput, onStart, onEnd, onKey }) {
  const document = page.ownerDocument;
  const window = document.defaultView;
  const listeners = [];
  const listen = (target, name, callback, options = true) => {
    target.addEventListener(name, callback, options);
    listeners.push(() => target.removeEventListener(name, callback, options));
  };
  const overlay = document.createElement('div');
  overlay.className = 'project-terminal-joystick';
  overlay.hidden = true;
  overlay.setAttribute('role', 'group');
  overlay.setAttribute('aria-label', 'Terminal directions');
  overlay.innerHTML = '<button type="button" data-direction="ArrowUp" aria-label="Up">↑</button>'
    + '<button type="button" data-direction="ArrowLeft" aria-label="Left">←</button>'
    + '<span class="project-terminal-joystick-center"></span>'
    + '<button type="button" data-direction="ArrowRight" aria-label="Right">→</button>'
    + '<button type="button" data-direction="ArrowDown" aria-label="Down">↓</button>';
  page.appendChild(overlay);
  let gesture = null;
  let holdTimer;
  let repeatTimer;
  let suppressUntil = 0;
  let outsideTap = null;

  function stop() {
    window.clearTimeout(holdTimer);
    window.clearTimeout(repeatTimer);
    if (gesture?.active) {
      suppressUntil = Date.now() + 700;
      onEnd();
    }
    gesture = null;
    delete overlay.dataset.direction;
  }

  function reset() {
    stop();
    outsideTap = null;
    overlay.hidden = true;
  }

  function finishOutsideTap() {
    const dismiss = !outsideTap.moved;
    outsideTap = null;
    if (dismiss) {
      reset();
      suppressUntil = Date.now() + 700;
    }
  }

  function repeat() {
    if (!gesture?.active || !gesture.key || !canInput() || document.hidden) return reset();
    onKey(gesture.key);
    repeatTimer = window.setTimeout(repeat, gesture.interval);
  }

  listen(page, 'pointerdown', event => {
    suppressUntil = 0;
    if (overlay.hidden) return;
    if (!canInput() || event.isPrimary === false) { reset(); return; }
    onStart();
    event.stopImmediatePropagation();
    if (!overlay.contains(event.target)) {
      outsideTap = { x: event.clientX, y: event.clientY, moved: false, touch: false };
      return;
    }
    event.preventDefault();
    const button = event.target.closest('button[data-direction]');
    if (!button) return;
    stop();
    gesture = { id: event.pointerId, active: true, button: true, key: button.dataset.direction, interval: 70 };
    overlay.dataset.direction = gesture.key;
    button.setPointerCapture?.(event.pointerId);
    onKey(gesture.key);
    repeatTimer = window.setTimeout(repeat, 300);
  });
  listen(page, 'pointermove', event => {
    if (outsideTap && Math.hypot(event.clientX - outsideTap.x, event.clientY - outsideTap.y) > 8) outsideTap.moved = true;
  });

  listen(page, 'touchstart', event => {
    if (event.touches.length !== 1) { reset(); return; }
    if (overlay.contains(event.target)) return;
    const touch = event.touches[0];
    if (!overlay.hidden) {
      onStart();
      outsideTap = { x: touch.clientX, y: touch.clientY, moved: false, touch: true };
      return;
    }
    reset();
    suppressUntil = 0;
    if (!canInput() || !screen.contains(event.target)
      || event.target.closest?.('button, a, textarea, input, .xterm-scrollbar')) return;
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, active: false, key: null, interval: 300 };
    holdTimer = window.setTimeout(() => {
      if (!gesture || !canInput() || document.hidden) return reset();
      gesture.active = true;
      onStart();
      const bounds = screen.getBoundingClientRect();
      const insetX = Math.min(88, (bounds.right - bounds.left) / 2);
      const insetY = Math.min(88, (bounds.bottom - bounds.top) / 2);
      const centerX = Math.max(bounds.left + insetX, Math.min(bounds.right - insetX, gesture.x));
      const centerY = Math.max(bounds.top + insetY, Math.min(bounds.bottom - insetY, gesture.y));
      gesture.x = centerX;
      gesture.y = centerY;
      overlay.style.left = `${centerX}px`;
      overlay.style.top = `${centerY}px`;
      overlay.hidden = false;
    }, 450);
  }, { capture: true, passive: true });

  listen(page, 'touchmove', event => {
    if (event.touches.length !== 1 || !canInput()) { reset(); return; }
    if (outsideTap) {
      const touch = event.touches[0];
      if (Math.hypot(touch.clientX - outsideTap.x, touch.clientY - outsideTap.y) > 8) outsideTap.moved = true;
      return;
    }
    if (!gesture) return;
    if (gesture.button) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const touch = Array.from(event.touches).find(candidate => candidate.identifier === gesture.id);
    if (!touch) return reset();
    const deltaX = touch.clientX - gesture.x;
    const deltaY = touch.clientY - gesture.y;
    const distance = Math.hypot(deltaX, deltaY);
    if (!gesture.active) {
      if (distance > 8) reset();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const previous = gesture.key;
    let horizontal = Math.abs(deltaX) > Math.abs(deltaY);
    if (previous && Math.abs(Math.abs(deltaX) - Math.abs(deltaY)) < 6) {
      horizontal = previous === 'ArrowLeft' || previous === 'ArrowRight';
    }
    const travel = horizontal ? Math.abs(deltaX) : Math.abs(deltaY);
    const crossTravel = horizontal ? Math.abs(deltaY) : Math.abs(deltaX);
    const key = horizontal
      ? (deltaX < 0 ? 'ArrowLeft' : 'ArrowRight') : (deltaY < 0 ? 'ArrowUp' : 'ArrowDown');
    gesture.key = travel >= 25 && crossTravel <= 22 && (travel <= 69 || previous === key) ? key : null;
    const interval = travel < 40 ? 300 : travel < 60 ? 150 : 70;
    if (gesture.key !== previous || gesture.interval !== interval) {
      window.clearTimeout(repeatTimer);
      gesture.interval = interval;
      overlay.dataset.direction = gesture.key || '';
      if (gesture.key) {
        if (gesture.key !== previous) onKey(gesture.key);
        repeatTimer = window.setTimeout(repeat, interval);
      }
    }
  }, { capture: true, passive: false });

  listen(page, 'touchend', event => {
    if (outsideTap) {
      if (!outsideTap.moved) event.preventDefault();
      finishOutsideTap();
      return;
    }
    if (Date.now() < suppressUntil) event.preventDefault();
    if (!gesture || !Array.from(event.changedTouches).some(touch => touch.identifier === gesture.id)) return;
    if (gesture.active) event.preventDefault();
    stop();
  }, { capture: true, passive: false });
  listen(page, 'touchcancel', reset);
  listen(page, 'pointercancel', reset);
  listen(page, 'pointerup', event => {
    if (outsideTap || gesture?.active || Date.now() < suppressUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (outsideTap && !outsideTap.touch) finishOutsideTap();
    if (gesture?.button && gesture.id === event.pointerId) stop();
  });
  for (const name of ['mousedown', 'mouseup', 'click', 'contextmenu']) {
    listen(page, name, event => {
      if (outsideTap || gesture?.active || Date.now() < suppressUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else if (name === 'click' && !overlay.hidden && !overlay.contains(event.target)) {
        onStart();
        reset();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    });
  }
  listen(overlay, 'click', event => {
    const button = event.target.closest('button[data-direction]');
    if (!button || !canInput()) return;
    event.preventDefault();
    onKey(button.dataset.direction);
    onEnd();
  });
  listen(window, 'resize', reset);
  if (window.visualViewport) listen(window.visualViewport, 'resize', reset);

  return {
    reset,
    dispose() {
      reset();
      for (const remove of listeners) remove();
      overlay.remove();
    },
  };
}
