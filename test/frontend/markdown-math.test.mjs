import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import hljs from 'highlight.js';
import { Marked } from 'marked';
import markedFootnote from 'marked-footnote';

const source = fs.readFileSync(
  new URL('../../web/js/components/markdown.js', import.meta.url),
  'utf8',
).replace(/^import markedFootnote from 'marked-footnote';\n/m, '');

function setupMarkdown(t) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.marked = new Marked();
  window.markedFootnote = markedFootnote;
  window.hljs = hljs;
  window.katexHtml = (tex, display) => {
    const span = window.document.createElement('span');
    span.className = display ? 'katex-display' : 'katex';
    span.textContent = tex;
    return span.outerHTML;
  };
  window.eval(source);
  return window;
}

const pricingTable = [
  '| 活跃用户 | Lightsail | EC2 + CloudFront |',
  '|---|---|---|',
  '| **100** | $7–12 套餐（WS 进出约 100GB，在额度内）；附件 100GB 在 S3 免费额度内 → **~$12** | t4g.small + IP + 磁盘 ~$20；按量计费的上行 ~$3 → **~$26** |',
  '| **1,000** | $12–24 套餐（WS 计入约 1TB，在额度内）；附件 1TB 走 CloudFront 按量计费，在 1TB 免费额度内 → **~$25–35** | t4g.medium ~$37 + Pro $15 → **~$58** |',
  '| **1 万** | WS 计入约 10TB，需要 2–3 台加分片，或者付超额费；附件走 CloudFront Pro → **~$100–130** | c7g.large ~$70 + Pro $15 + 其它 → **~$105–125，单机** |',
].join('\n');

const revisedTable = [
  '## 修正后的费用',
  '',
  '| 活跃用户 | 按量计费 | 包月套餐 |',
  '|---|---|---|',
  '| 100 | 上行 50GB × $0.06 = **+$3** | Free 套餐的 100GB 额度不够 |',
  '| 1,000 | 上行 500GB × $0.06 = **+$30**；下行在 1TB 免费额度内 | **Pro $15**，更划算 |',
  '| 1 万 | 上行 $300 + 下行 $460+ | **Pro $15**：上行加附件约 20TB，在 50TB 额度内 |',
].join('\n');

test('pricing tables preserve currency, text and bold amounts', t => {
  const window = setupMarkdown(t);
  const host = window.document.createElement('div');
  const standard = new Marked({ breaks: true, gfm: true });
  for (const input of [pricingTable, revisedTable]) {
    const expected = standard.parse(input.replace(/~(?=\$)/g, '\\~'));
    assert.equal(window.renderMd(input), expected);
    assert.equal(window.renderAssistantText(input), expected);
    assert.equal(window.renderMdDocument(input, html => {
      const root = window.document.createElement('div');
      root.innerHTML = html;
      return root;
    }), expected);
    host.innerHTML = window.renderMd(input);
    assert.equal(host.querySelectorAll('tbody tr').length, 3);
    assert.equal(host.querySelector('.katex, .katex-display'), null);
  }
  host.innerHTML = window.renderMd(pricingTable);
  assert.deepEqual([...host.querySelectorAll('tbody strong')].map(el => el.textContent),
    ['100', '~$12', '~$26', '1,000', '~$25–35', '~$58', '1 万', '~$100–130', '~$105–125，单机']);
});

test('streamed pricing keeps completed bold amounts as later dollar signs arrive', t => {
  const window = setupMarkdown(t);
  const host = window.document.createElement('div');
  const input = '上行 50GB × $0.06 = **+$3**；Pro $15，总计 **~$18**。';
  const boldEnd = input.indexOf('**；') + 2;
  for (let length = 1; length <= input.length; length++) {
    window.renderStreamMd(host, input.slice(0, length));
    if (length >= boldEnd) {
      assert.equal(host.querySelector('strong')?.textContent, '+$3', `prefix ${length}`);
    }
  }
  assert.equal(host.querySelector('.katex, .katex-display'), null);
  assert.equal(host.textContent.trim(), '上行 50GB × $0.06 = +$3；Pro $15，总计 ~$18。');
});

test('pricing advice preserves bold plans and multiple prices within prose', t => {
  const window = setupMarkdown(t);
  const host = window.document.createElement('div');
  const input = [
    '**怎么选：**',
    '',
    '- **$5（0.5GB）**：跑 Node 中转加 Caddy 能起来，但内存太紧，只适合测试。',
    '- **$7（1GB）**：早期几百个用户够用。这是最低的合理选择。',
    '- **$12（2GB）**：余量更足，我建议正式上线用这个。',
    '',
    '按上一轮定的顺序，第一版先只用 Lambda + API Gateway。等月账单超过 $50–100、切换到 Lightsail 时，从 **$7 或 $12 的套餐**起步就行。',
  ].join('\n');
  const expected = new Marked({ breaks: true, gfm: true }).parse(input);
  assert.equal(window.renderAssistantText(input), expected);
  window.renderStreamMd(host, input);
  assert.equal(host.innerHTML, expected);
  assert.equal(host.querySelector('.katex, em'), null);
  assert.deepEqual([...host.querySelectorAll('strong')].map(el => el.textContent),
    ['怎么选：', '$5（0.5GB）', '$7（1GB）', '$12（2GB）', '$7 或 $12 的套餐']);
});

test('single tildes stay literal and double tildes mark strikethrough', t => {
  const window = setupMarkdown(t);
  const host = window.document.createElement('div');
  host.innerHTML = window.renderMd('~$20 + ~$3 → **~$26**；~100 + ~3；~旧方案~，~~$30~~，~~旧方案~~。');
  assert.equal(host.textContent.trim(), '~$20 + ~$3 → ~$26；~100 + ~3；~旧方案~，$30，旧方案。');
  assert.deepEqual([...host.querySelectorAll('del')].map(el => el.textContent), ['$30', '旧方案']);
  assert.equal(host.querySelector('strong').textContent, '~$26');
});

test('dollar math uses delimiter boundaries while prices stay literal', t => {
  const window = setupMarkdown(t);
  const host = window.document.createElement('div');
  const standard = new Marked({ breaks: true, gfm: true });
  for (const input of [
    'Cost $5 and $10, or **$12**.',
    '$7–12 套餐 → **~$12**',
    '$10/month + $20/month',
    '$ x$ / $x $ / $x$2',
    String.raw`\$5 and \$10; \*\*+$3\*\*`,
    '`$x$` and `$5 + $10`',
  ]) {
    assert.equal(window.renderMd(input), standard.parse(input), input);
  }

  for (const [input, expected] of [
    ['$x$', 'x'],
    ['结果为$x^2 + y^2$。', 'x^2 + y^2'],
    ['$1 + 2 = 3$', '1 + 2 = 3'],
    [String.raw`$\text{Price: \$5}$`, String.raw`\text{Price: \$5}`],
    [String.raw`\( x + 1 \)`, 'x + 1'],
    ['$`a *b* c`$', 'a *b* c'],
    ['$`a **b** c`$', 'a **b** c'],
    ['$`[x](y)`$', '[x](y)'],
  ]) {
    host.innerHTML = window.renderMd(input);
    assert.equal(host.querySelectorAll('.katex').length, 1, input);
    assert.equal(host.querySelector('.katex')?.textContent, expected, input);
  }
  host.innerHTML = window.renderMd('价格 $5 和 $10，公式 $x + 1$，合计 **$15**。');
  assert.equal(host.querySelectorAll('.katex').length, 1);
  assert.equal(host.querySelector('.katex').textContent, 'x + 1');
  assert.equal(host.querySelector('strong').textContent, '$15');
});

test('bare dollar math respects other Markdown token boundaries', t => {
  const window = setupMarkdown(t);
  const host = window.document.createElement('div');
  const standard = new Marked({ breaks: true, gfm: true });
  for (const input of [
    '$a **b** c$',
    '$a *b* c$',
    '$a `b` c$',
    '$a ~~b~~ c$',
  ]) {
    assert.equal(window.renderMd(input), standard.parse(input), input);
  }
  host.innerHTML = window.renderMd('$a [b](https://example.com) c$');
  assert.equal(host.querySelector('.katex'), null);
  assert.equal(host.querySelector('a').textContent, 'b');
});

test('display math, escaped delimiters and fenced code keep their boundaries', t => {
  const window = setupMarkdown(t);
  const host = window.document.createElement('div');
  for (const input of [
    '**公式**\n$$\nx + y\n$$',
    '$$x + y$$',
    String.raw`\[x + y\]`,
  ]) {
    host.innerHTML = window.renderMd(input);
    assert.equal(host.querySelectorAll('.katex-display').length, 1, input);
    assert.equal(host.querySelector('.katex-display').textContent, 'x + y', input);
    assert.equal(host.querySelector('.katex'), null, input);
  }
  host.innerHTML = window.renderMd('```text\n$x$ **+$3** $5\n```');
  assert.equal(host.querySelector('.katex, strong'), null);
  assert.equal(host.querySelector('code').textContent, '$x$ **+$3** $5');
});

test('rejected formula delimiters cannot reopen and swallow following Markdown', t => {
  const window = setupMarkdown(t);
  const host = window.document.createElement('div');
  const standard = new Marked({ gfm: true, breaks: true });
  for (const input of ['$$x$', '$x$$y$', '$x $；前部空格：$ x$。', '$a **b** c$']) {
    host.innerHTML = window.renderMd(input);
    assert.equal(host.querySelector('.katex'), null, input);
    assert.equal(host.innerHTML, standard.parse(input), input);
  }
  host.innerHTML = window.renderMd('$a **b** c$；保护语法：$`a **b** c`$');
  assert.equal(host.querySelectorAll('.katex').length, 1);
  assert.equal(host.querySelector('.katex').textContent, 'a **b** c');
  assert.equal(host.querySelector('strong').textContent, 'b');
  for (const input of ['$$x$', '$a **b** c$；保护语法：$`a **b** c`$']) {
    for (let length = 1; length <= input.length; length++) {
      assert.doesNotThrow(() => window.renderStreamMd(host, input.slice(0, length)));
    }
    assert.equal(host.innerHTML, window.renderAssistantText(input));
  }
});

test('chat, streaming and document renderers share math fences and GitHub alerts', t => {
  const window = setupMarkdown(t);
  const host = window.document.createElement('div');
  const input = '> [!WARNING]\n> **Careful** with $5 and $10.\n\n```math\nx^2 + 1\n```';
  const renderers = [
    text => window.renderMd(text),
    text => window.renderAssistantText(text),
    text => { window.renderStreamMd(host, text); return host.innerHTML; },
    text => window.renderMdDocument(text, html => {
      const root = window.document.createElement('div');
      root.innerHTML = html;
      window.decorateMarkdown(root);
      return root;
    }),
  ];
  for (const render of renderers) {
    host.innerHTML = render(input);
    assert.equal(host.querySelector('.markdown-alert-title').textContent, 'Warning');
    assert.equal(host.querySelector('.markdown-alert strong').textContent, 'Careful');
    assert.equal(host.querySelector('.katex-display').textContent, 'x^2 + 1');
    assert.equal(host.querySelector('pre'), null);
  }
  host.innerHTML = window.renderMd('```\n> [!NOTE]\n```\n\n> ordinary quote\n\n> [!UNKNOWN]\n> text');
  assert.equal(host.querySelector('.markdown-alert'), null);
  assert.equal(host.querySelectorAll('blockquote').length, 2);
});

test('footnotes use reference order, preserve content and navigate within the current message', t => {
  const window = setupMarkdown(t);
  const input = 'Second[^b], first[^a], second again[^b].\n\n[^a]: Alpha.\n[^b]: **Beta**.\n    Continuation.';
  const one = window.document.createElement('div');
  const two = window.document.createElement('div');
  one.className = two.className = 'assistant-text';
  one.innerHTML = window.renderMd(input);
  window.renderStreamMd(two, input);
  window.document.body.append(one, two);
  const refs = [...two.querySelectorAll('[data-footnote-ref]')];
  assert.deepEqual(refs.map(el => el.textContent), ['1', '2', '1']);
  assert.equal(two.querySelectorAll('.footnotes li').length, 2);
  assert.equal(two.querySelector('.footnotes strong').textContent, 'Beta');
  assert.match(two.querySelector('.footnotes').textContent, /Continuation/);
  assert.equal(two.querySelectorAll('.footnotes [data-footnote-backref]').length, 3);
  assert.equal(two.querySelector('.file-link'), null);
  const destination = [...two.querySelectorAll('[id]')].find(el => '#' + el.id === refs[0].getAttribute('href'));
  let scrolled = false;
  destination.scrollIntoView = () => { scrolled = true; };
  refs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(scrolled, true);
  scrolled = false;
  refs[0].scrollIntoView = () => { scrolled = true; };
  two.querySelector('[data-footnote-backref]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(scrolled, true);

  one.innerHTML = window.renderMd('Unknown[^missing] and `[^a]`.\n\n[^a]: unused');
  assert.equal(one.querySelector('[data-footnote-ref], .footnotes'), null);
  assert.match(one.textContent, /Unknown\[\^missing\]/);
  one.innerHTML = window.renderMd('Check[^x" onclick="alert(1)].\n\n[^x" onclick="alert(1)]: safe');
  assert.equal(one.querySelector('[onclick], script'), null);
});

test('streamed footnotes resolve across persistent diagrams and previews', t => {
  const window = setupMarkdown(t);
  const host = window.document.createElement('div');
  const marker = 'visualize{"path":"/tmp/report.html"}';
  const input = 'See note[^a].\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n'
    + marker + '\n\n[^a]: **Definition** after the diagram.';
  window.renderStreamMd(host, input);
  const diagram = host.querySelector('.mermaid-block');
  const preview = host.querySelector('.codex-visualization');
  diagram.querySelector('.mermaid-svg').innerHTML = '<svg></svg>';
  preview.dataset.loaded = 'yes';
  window.renderStreamMd(host, input + '\n\nMore text.');
  assert.equal(host.querySelector('.mermaid-block'), diagram);
  assert.ok(diagram.querySelector('svg'));
  assert.equal(host.querySelector('.codex-visualization'), preview);
  assert.equal(preview.dataset.loaded, 'yes');
  assert.equal(host.querySelector('[data-footnote-ref]').textContent, '1');
  assert.equal(host.querySelector('.footnotes strong').textContent, 'Definition');
});
