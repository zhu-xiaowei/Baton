function lines(text) {
  if (!text) return [];
  const result = text.replace(/\r\n?/g, '\n').split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}

async function editBlocks(oldText, newText) {
  const { diffLines } = await import('diff');
  const parts = diffLines(oldText, newText);
  const blocks = [];
  for (let index = 0; index < parts.length;) {
    if (!parts[index].added && !parts[index].removed) { index++; continue; }
    const before = lines(parts[index - 1]?.value || '').slice(-3);
    const added = [];
    while (index < parts.length && (parts[index].added || parts[index].removed)) {
      if (parts[index].added) added.push(...lines(parts[index].value));
      index++;
    }
    const after = lines(parts[index]?.value || '').slice(0, 3);
    blocks.push({
      lines: [...before, ...added, ...after],
      offset: added.length || after.length ? before.length : Math.max(0, before.length - 1),
      length: added.length || 1,
      deletion: added.length === 0,
    });
  }
  return blocks;
}

function lineIndex(fileLines, normalize) {
  const index = new Map();
  fileLines.forEach((line, position) => {
    const key = normalize(line);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(position);
  });
  return index;
}

function uniqueMatch(fileLines, pattern, index, normalize) {
  let candidates = null;
  let anchor = 0;
  for (let offset = 0; offset < pattern.length; offset++) {
    const positions = index.get(normalize(pattern[offset])) || [];
    if (!candidates || positions.length < candidates.length) {
      candidates = positions;
      anchor = offset;
    }
  }
  let match = -1;
  for (const position of candidates || []) {
    const start = position - anchor;
    if (start < 0 || start + pattern.length > fileLines.length) continue;
    if (!pattern.every((line, offset) => normalize(fileLines[start + offset]) === normalize(line))) continue;
    if (match !== -1) return -2;
    match = start;
  }
  return match;
}

function locateBlocks(text, blocks) {
  const fileLines = lines(text);
  const exact = lineIndex(fileLines, line => line);
  let trimmed;
  const patterns = new Map();
  for (const block of blocks) {
    const key = JSON.stringify(block.lines);
    patterns.set(key, (patterns.get(key) || 0) + 1);
  }
  const ranges = [];
  for (const block of blocks) {
    if (!block.lines.some(line => line.trim())
      || patterns.get(JSON.stringify(block.lines)) !== 1) continue;
    let position = uniqueMatch(fileLines, block.lines, exact, line => line);
    if (position === -1) {
      trimmed ||= lineIndex(fileLines, line => line.trim());
      position = uniqueMatch(fileLines, block.lines, trimmed, line => line.trim());
    }
    if (position < 0) continue;
    const from = position + block.offset + 1;
    ranges.push({ from, to: from + block.length - 1, ...(block.deletion ? { deletion: true } : {}) });
  }
  ranges.sort((left, right) => left.from - right.from);
  return ranges.reduce((merged, range) => {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
      if (!range.deletion) delete previous.deletion;
    } else merged.push(range);
    return merged;
  }, []);
}

export async function resolveEditLocation(text, input, version, previous) {
  input ||= {};
  const oldText = String(input.old_string || '').replace(/\r\n?/g, '\n');
  const newText = String(input.new_string || '').replace(/\r\n?/g, '\n');
  const sameEdit = previous?.oldText === oldText && previous?.newText === newText;
  if (sameEdit && version && previous.version === version) return previous;
  const blocks = sameEdit ? previous.blocks : await editBlocks(oldText, newText);
  return { oldText, newText, blocks, version: version || '', ranges: locateBlocks(text, blocks) };
}
