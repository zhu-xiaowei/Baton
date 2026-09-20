export function refreshThinkingGroups(container, now = Date.now()) {
  if (!container) return;
  let group = [];

  function flush() {
    if (!group.length) return;
    let duration = 0;
    let timed = false;
    let running = false;
    for (const [index, row] of group.entries()) {
      row.classList.toggle('thinking-group-hidden', index > 0);
      const block = row.querySelector('.thinking-block');
      if (block.hasAttribute('data-thinking-duration-ms')) {
        timed = true;
        duration += Number(block.dataset.thinkingDurationMs) || 0;
      }
      if (block.hasAttribute('data-thinking-started-at')) {
        running = true;
        duration += Math.max(0, now - Number(block.dataset.thinkingStartedAt));
      }
    }
    const label = group[0].querySelector('.thinking-label');
    const seconds = Math.round(duration / 1000);
    const text = running ? `Thinking ${seconds}s`
      : timed ? `Thought for ${seconds}s` : 'Thinking';
    if (label && label.textContent !== text) label.textContent = text;
    group = [];
  }

  function visit(row) {
    if (!row.classList.contains('thinking-tl')
      || !row.querySelector('.thinking-block')) {
      flush();
      return;
    }
    const empty = !row.querySelector('.thinking-body')?.textContent.trim();
    row.classList.toggle('thinking-empty', empty);
    if (!empty) flush();
    group.push(row);
    if (!empty) flush();
  }

  for (const element of container.children) {
    if (element.classList.contains('assistant-turn')) {
      for (const row of element.children) visit(row);
    } else {
      visit(element);
    }
  }
  flush();
}
