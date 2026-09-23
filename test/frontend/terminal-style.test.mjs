import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const terminalCss = readFileSync(new URL('../../web/css/terminal.css', import.meta.url), 'utf8');
const xtermCss = readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
const breadcrumbCss = readFileSync(new URL('../../web/css/breadcrumb.css', import.meta.url), 'utf8');

test('the terminal selector matches the project label height on web and mobile', () => {
  const dom = new JSDOM('<!doctype html><head><style>' + appCss + breadcrumbCss + terminalCss + '</style></head>'
    + '<body><section class="project-terminal-page"><header class="path-breadcrumb project-terminal-header">'
    + '<div class="project-terminal-heading"><span class="path-breadcrumb-item project-terminal-project">Project</span></div>'
    + '<button class="project-terminal-action project-terminal-selector"><span>Terminal 1</span><svg class="project-terminal-selector-chevron"></svg></button>'
    + '</header><div class="project-terminal-menu"><button class="project-terminal-option">Terminal 1</button></div>'
    + '</section></body>');
  try {
    const selector = dom.window.document.querySelector('.project-terminal-selector');
    const project = dom.window.document.querySelector('.project-terminal-project');
    for (const mobile of [false, true]) {
      dom.window.document.documentElement.classList.toggle('native-mobile', mobile);
      const selectorStyle = dom.window.getComputedStyle(selector);
      const projectStyle = dom.window.getComputedStyle(project);
      assert.equal(selectorStyle.height, 'auto');
      for (const property of ['fontSize', 'lineHeight', 'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']) {
        assert.equal(selectorStyle[property], projectStyle[property], property);
      }
    }
    const option = dom.window.document.querySelector('.project-terminal-option');
    assert.equal(dom.window.getComputedStyle(option).minHeight, '44px');
  } finally {
    dom.window.close();
  }
});

test('the terminal scrollbar has rounded corners without changing auto-hide behavior', () => {
  const dom = new JSDOM('<!doctype html><html class="native-mobile"><head><style>' + terminalCss + xtermCss + '</style></head>'
    + '<body><main class="project-terminal-screen"><div class="xterm"><div class="xterm-scrollable-element">'
    + '<div class="xterm-scrollbar xterm-vertical xterm-visible"><div class="xterm-slider"></div></div>'
    + '</div></div></main></body></html>');
  try {
    const scrollbar = dom.window.document.querySelector('.xterm-scrollbar');
    const slider = scrollbar.querySelector('.xterm-slider');
    assert.equal(dom.window.getComputedStyle(slider).borderRadius, '3px');
    assert.equal(dom.window.getComputedStyle(scrollbar).backgroundColor, 'rgba(0, 0, 0, 0)');
    assert.equal(dom.window.getComputedStyle(scrollbar).opacity, '1');
    scrollbar.className = 'xterm-scrollbar xterm-vertical xterm-invisible xterm-fade';
    assert.equal(dom.window.getComputedStyle(scrollbar).opacity, '0');
    assert.equal(dom.window.getComputedStyle(scrollbar).pointerEvents, 'none');
  } finally {
    dom.window.close();
  }
});

test('terminal history does not create a second vertical scroller or consume fit space with padding', () => {
  const dom = new JSDOM('<style>' + appCss + terminalCss + '</style><main class="project-terminal-screen"></main>');
  try {
    const style = dom.window.getComputedStyle(dom.window.document.querySelector('main'));
    assert.equal(style.overflowY, 'hidden');
    assert.equal(style.overflowX, 'auto');
    assert.equal(style.paddingTop, '0px');
    assert.equal(style.paddingBottom, '0px');
    assert.equal(style.touchAction, 'pan-x pinch-zoom');
  } finally {
    dom.window.close();
  }
});

test('the mobile terminal keeps its right edge flush and bottom safe area reserved', () => {
  const dom = new JSDOM('<html class="native-mobile"><style>' + terminalCss + '</style>'
    + '<section class="project-terminal-page"><main class="project-terminal-screen"></main></section></html>');
  try {
    assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('main')).marginRight, '0px');
    assert.match(terminalCss, /@media \(pointer: coarse\)\s*\{\s*\.project-terminal-screen\s*\{\s*margin-right: 0;/);
    const page = dom.window.document.querySelector('section');
    for (const keyboardOpen of [false, true, false]) {
      page.classList.toggle('keyboard-open', keyboardOpen);
      const style = dom.window.getComputedStyle(page);
      assert.equal(style.boxSizing, 'border-box');
      assert.equal(style.paddingBottom, 'max(4px, var(--sab, env(safe-area-inset-bottom, 0px)))');
      assert.equal(parseFloat(dom.window.getComputedStyle(page.querySelector('main')).marginBottom), 0);
    }
  } finally {
    dom.window.close();
  }
});

for (const [order, styles] of [
  ['before', [xtermCss, terminalCss]],
  ['after', [terminalCss, xtermCss]],
]) {
  test(`terminal keeps a solid background when xterm CSS loads ${order} page CSS`, () => {
    const dom = new JSDOM('<!doctype html><head>'
      + styles.map(css => '<style>' + css + '</style>').join('')
      + '</head><body><section class="project-terminal-page"><main class="project-terminal-screen">'
      + '<div class="xterm"><div class="xterm-viewport"></div><div class="xterm-screen"></div></div>'
      + '</main></section></body>');
    try {
      const page = dom.window.document.querySelector('.project-terminal-page');
      const viewport = dom.window.document.querySelector('.xterm-viewport');
      assert.equal(dom.window.getComputedStyle(viewport).backgroundColor,
        dom.window.getComputedStyle(page).backgroundColor);
    } finally {
      dom.window.close();
    }
  });
}
