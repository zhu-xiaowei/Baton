import { downloadFile } from '../project/download.js';

import { localImageFile, MAX_IMAGE_BYTES as MAX_BYTES } from './local-image.js';
export { localImageFile };

function utf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_BYTES) throw new Error('Diagram export exceeds 32 MiB.');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

export function snapshotDiagram(svg, viewBox) {
  if (!svg || svg.localName !== 'svg') throw new Error('The diagram has not finished rendering. Try again shortly.');
  const clone = svg.cloneNode(true);
  const sourceNodes = [svg, ...svg.querySelectorAll('*')];
  const cloneNodes = [clone, ...clone.querySelectorAll('*')];
  const properties = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'color',
    'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
    'background-color', 'border-color', 'line-height', 'white-space', 'text-align'];
  sourceNodes.forEach((source, i) => {
    const style = getComputedStyle(source);
    for (const property of properties) {
      const value = style.getPropertyValue(property);
      if (value) cloneNodes[i].style.setProperty(property, value);
    }
  });
  clone.querySelectorAll('script, iframe, object, embed').forEach(node => node.remove());
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || (/href$/i.test(attr.name) && !attr.value.startsWith('#'))) node.removeAttribute(attr.name);
    }
  }
  const box = (viewBox || svg.getAttribute('viewBox') || '').trim().split(/[ ,]+/).map(Number);
  const width = box.length === 4 && box.every(Number.isFinite) ? box[2] : svg.getBoundingClientRect().width;
  const height = box.length === 4 && box.every(Number.isFinite) ? box[3] : svg.getBoundingClientRect().height;
  if (!(width > 0 && height > 0)) throw new Error('The diagram size is not ready.');
  if (viewBox) clone.setAttribute('viewBox', viewBox);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width)); clone.setAttribute('height', String(height));
  clone.style.setProperty('max-width', 'none'); clone.style.setProperty('width', `${width}px`);
  clone.style.setProperty('height', `${height}px`);
  const backgroundNode = svg.closest('.mermaid-block, .mermaid-fs-overlay') || document.body;
  const color = getComputedStyle(backgroundNode).backgroundColor;
  const background = color && !['transparent', 'rgba(0, 0, 0, 0)'].includes(color) ? color : '#ffffff';
  clone.style.setProperty('background-color', background);
  return { file: localImageFile('data:image/svg+xml;base64,' + utf8Base64(new XMLSerializer().serializeToString(clone)), 'diagram.svg'),
    width, height, background };
}

export function diagramPng(snapshot, signal) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      image.onload = image.onerror = null;
      image.src = '';
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(signal.reason || new DOMException('Cancelled', 'AbortError'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    image.onerror = () => finish(new Error('Could not create PNG. Try SVG instead.'));
    image.onload = () => {
      const canvas = document.createElement('canvas');
      try {
        const scale = Math.min(2, 8192 / snapshot.width, 8192 / snapshot.height,
          Math.sqrt(16_000_000 / (snapshot.width * snapshot.height)));
        canvas.width = Math.max(1, Math.round(snapshot.width * scale));
        canvas.height = Math.max(1, Math.round(snapshot.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create a PNG canvas. Try SVG instead.');
        context.fillStyle = snapshot.background; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        finish(null, localImageFile(canvas.toDataURL('image/png'), 'diagram.png'));
      } catch { finish(new Error('Could not create PNG. Try SVG instead.')); }
      finally { canvas.width = canvas.height = 0; }
    };
    image.src = snapshot.file.url;
  });
}

let exporting = false;

export function diagramExport(getSvg, getViewBox) {
  const menu = document.createElement('details');
  menu.className = 'diagram-export';
  const summary = document.createElement('summary');
  summary.textContent = 'Export';
  const choices = document.createElement('div');
  choices.className = 'diagram-export-choices';
  const status = document.createElement('span');
  status.className = 'diagram-export-status';
  status.setAttribute('role', 'status');
  for (const format of ['png', 'svg']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = format.toUpperCase();
    button.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      if (exporting) return;
      exporting = true;
      choices.querySelectorAll('button').forEach(item => { item.disabled = true; });
      status.textContent = 'Saving…';
      menu.open = true;
      try {
        // Snapshot before awaiting: streaming and fullscreen pan must not change this export.
        const snapshot = snapshotDiagram(getSvg(), getViewBox?.());
        const file = format === 'png' ? await diagramPng(snapshot) : snapshot.file;
        const result = await downloadFile(file);
        status.textContent = ({ saved: 'Saved to Downloads.', shared: 'Shared.',
          share_opened: 'Share sheet opened.', cancelled: 'Cancelled.' })[result?.status] || 'Download started.';
      } catch (error) {
        status.textContent = error.message || 'Export failed. Please retry.';
      } finally {
        exporting = false;
        choices.querySelectorAll('button').forEach(item => { item.disabled = false; });
      }
    });
    choices.append(button);
  }
  choices.append(status);
  menu.append(summary, choices);
  return menu;
}

window.createDiagramExport = diagramExport;
