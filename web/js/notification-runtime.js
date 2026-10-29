// In-flight responses cannot display alerts after the app leaves the foreground.
export function validNotificationTarget(event) {
  return !!event && ['device', 'projectHash', 'sessionId'].every(key =>
    typeof event[key] === 'string' && event[key].length > 0 && event[key].length < 1024);
}

export function createForegroundNotifications({
  fetchEvents, show, enabled = () => true, isVisible,
  onError = () => {}, schedule = setTimeout, cancel = clearTimeout,
  interval = 5000,
}) {
  let generation = 0;
  let timer;
  const seen = new Set();
  async function poll(current, cursor = '') {
    if (current !== generation || !isVisible()) return;
    try {
      const result = await fetchEvents(cursor);
      if (current !== generation || !isVisible()) return;
      if (cursor) {
        for (const event of result.events || []) {
          if (current !== generation || !isVisible()) return;
          if (!validNotificationTarget(event) || seen.has(event.eventId)) continue;
          if (enabled(event)) await show(event);
          seen.add(event.eventId);
          if (seen.size > 500) seen.delete(seen.values().next().value);
        }
      }
      cursor = result.cursor;
    } catch (error) {
      onError(error);
    }
    if (current === generation && isVisible()) {
      timer = schedule(() => { void poll(current, cursor); }, interval);
    }
  }
  return {
    start() {
      cancel(timer);
      void poll(++generation);
    },
    stop() {
      ++generation;
      cancel(timer);
    },
  };
}
