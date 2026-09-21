export function systemEventId(message) {
  return message.uuid || message.nativeId
    || JSON.stringify([message.timestamp || '', message.content]);
}

export function messageSegments(messages) {
  var segments = new Map();
  var segment = '';
  for (var message of messages) {
    if (message.type === 'system_event') segment = systemEventId(message);
    if (message.uuid) segments.set('uuid:' + message.uuid, segment);
    if (message.nativeId) segments.set('native:' + message.nativeId, segment);
    for (var block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use' && block.id) {
        segments.set('tool:' + block.id, segment);
      }
    }
  }
  return segments;
}

export function turnTimeline(container, turnId) {
  var children = Array.from(container.children);
  var anchorIndex = children.findIndex(element =>
    element.classList.contains('msg-user') && element.dataset.anchor === turnId);
  var anchor = children[anchorIndex] || null;
  if (!anchor && children.some(element => element.classList.contains('msg-user'))) {
    var matching = children.filter(element => element.dataset.turnId === turnId);
    var segment = matching.at(-1)?.dataset.timelineSegment || '';
    return { anchor, rows: matching, initialSegment: segment, segment };
  }
  var end = children.findIndex((element, index) => index > anchorIndex
    && (element.classList.contains('msg-user') || element.id === 'permission-prompt'));
  if (end === -1) end = children.length;
  var rows = children.slice(anchorIndex + 1, end);
  var previousEvent = children.slice(0, anchorIndex + 1).reverse()
    .find(element => element.classList.contains('msg-system-event'));
  var firstRow = rows.find(element => element.classList.contains('assistant-turn')
    || element.classList.contains('msg-system-event'));
  var initialSegment = previousEvent?.dataset.timelineSegment
    || (firstRow?.classList.contains('assistant-turn') ? firstRow.dataset.timelineSegment : '') || '';
  var latestEvent = rows.slice().reverse()
    .find(element => element.classList.contains('msg-system-event'));
  return {
    anchor, rows, initialSegment,
    segment: latestEvent?.dataset.timelineSegment || initialSegment,
  };
}

export function attachTimelineTurn(container, turn) {
  var timeline = turnTimeline(container, turn.dataset.turnId || '');
  if (!timeline.anchor && container.querySelector(':scope > .msg-user')) return false;
  var segment = turn.dataset.timelineSegment || '';
  var boundaryIndex = timeline.rows.findIndex(element =>
    element.classList.contains('msg-system-event')
      && element.dataset.timelineSegment === segment);
  if (boundaryIndex === -1 && segment !== timeline.initialSegment) return false;
  var insertionPoint = timeline.rows[boundaryIndex] || timeline.anchor;
  for (var element of timeline.rows.slice(boundaryIndex + 1)) {
    if (element === turn) return true;
    if (!element.classList.contains('assistant-turn')
      && !element.classList.contains('loading-older')) break;
    insertionPoint = element;
  }
  if (insertionPoint) insertionPoint.insertAdjacentElement('afterend', turn);
  else container.insertBefore(turn, container.firstElementChild);
  return true;
}
