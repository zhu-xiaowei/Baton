import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
await import('../../web/js/components/tool.js');
await import('../../web/js/render.js');

for (const kind of ['codex-ran', 'codex-explore', 'codex-called', 'claude-bash']) {
  test(`${kind} grouping leaves unchanged DOM intact and reuses the count when growing`, () => {
    const row = (id) => `<div class="assistant-turn"><div class="tl-item tool-node ${kind} tool-details-collapsed" data-tool-id="${kind}-${id}">`
      + '<div class="tool-header tool-details-toggle" aria-expanded="false"><span class="tool-name">Tool</span><span class="tool-desc">summary</span></div>'
      + '<div class="tool-body">output</div></div></div>';
    document.body.innerHTML = `<div class="messages">${row('one')}${row('two')}</div>`;
    const container = document.querySelector('.messages');
    window.markToolRunGroups(container);
    const nodes = Array.from(container.querySelectorAll('.tool-node'));
    const count = container.querySelector('.tool-run-group-count');
    const header = nodes[0].querySelector('.tool-header');
    const observer = new window.MutationObserver(() => {});
    observer.observe(container, { subtree: true, attributes: true, childList: true });

    window.markToolRunGroups(container);
    assert.equal(observer.takeRecords().length, 0);

    container.insertAdjacentHTML('beforeend', row('three'));
    observer.takeRecords();
    window.markToolRunGroups(container);
    const records = observer.takeRecords();
    assert.equal(container.querySelector('.tool-run-group-count'), count);
    assert.equal(nodes[0].querySelector('.tool-header'), header);
    assert.equal(count.textContent, '×3');
    assert.equal(container.querySelectorAll('.tool-run-group-hidden').length, 2);
    assert.equal(container.querySelectorAll('.tool-run-row-hidden').length, 2);
    assert.equal(records.filter((record) => record.type === 'attributes'
      && nodes.some((node) => node === record.target || node.contains(record.target))).length, 0);

    window.toggleToolDetails(header);
    observer.takeRecords();
    window.markToolRunGroups(container);
    assert.equal(observer.takeRecords().length, 0);
    assert.equal(container.querySelectorAll('.tool-run-group-hidden').length, 0);
    assert.equal(count.textContent, '×3');

    nodes[1].parentElement.insertAdjacentHTML('beforebegin', '<div class="msg-user">next</div>');
    window.markToolRunGroups(container);
    assert.equal(nodes[0].dataset.toolDetailsGroup, undefined);
    assert.equal(nodes[0].querySelector('.tool-run-group-count'), null);
    assert.equal(nodes[0].classList.contains('tool-run-group-start'), false);
    assert.equal(nodes[1].classList.contains('tool-run-group-start'), true);
    assert.equal(nodes[1].classList.contains('tool-run-continuation'), false);
    assert.equal(nodes[1].querySelector('.tool-run-group-count').textContent, '×2');
    assert.equal(container.querySelectorAll('.tool-run-row-hidden').length, 0);
    observer.disconnect();
  });
}

test('reclassifying a group clears the previous kind without losing its collapsed state', () => {
  document.body.innerHTML = '<div class="messages"><div class="assistant-turn">'
    + ['one', 'two'].map((id) => `<div class="tl-item tool-node codex-ran tool-details-collapsed" data-tool-id="reclassify-${id}">`
      + '<div class="tool-header tool-details-toggle" aria-expanded="false"><span class="tool-name">Tool</span></div>'
      + '<div class="tool-body">output</div></div>').join('')
    + '</div></div>';
  const container = document.querySelector('.messages');
  window.markToolRunGroups(container);
  const nodes = Array.from(container.querySelectorAll('.tool-node'));
  for (const node of nodes) node.classList.replace('codex-ran', 'codex-explore');

  window.markToolRunGroups(container);

  assert.equal(container.querySelectorAll('.codex-ran-group-start, .codex-ran-continuation, .codex-ran-group-count').length, 0);
  assert.equal(container.querySelectorAll('.tool-run-group-count').length, 1);
  assert.equal(container.querySelector('.codex-explore-group-count').textContent, '×2');
  assert.equal(container.querySelectorAll('.tool-run-group-hidden').length, 1);
  assert.ok(nodes.every((node) => node.dataset.toolRunKind === 'codex-explore'));
  assert.ok(nodes.every((node) => node.classList.contains('tool-details-collapsed')));
});
