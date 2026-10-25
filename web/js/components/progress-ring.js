// The upload progress ring, shared by staged attachments and download buttons.
// A container with `.has-progress` shows the pie; otherwise the open ring spins.
export function progressRingHtml() {
  // The ring spins as its own <svg> box: WebKit offsets a spinning element inside an SVG under page zoom.
  return '<span class="staged-progress-indicator">'
    + '<svg viewBox="0 0 36 36" shape-rendering="geometricPrecision">'
    + '<circle class="staged-progress-pie" cx="18" cy="18" r="6.5" fill="none" stroke="currentColor"'
    + ' stroke-width="13" pathLength="100" stroke-dasharray="100 100" transform="rotate(-90 18 18)"/></svg>'
    + '<svg class="staged-progress-orbit" viewBox="0 0 36 36" shape-rendering="geometricPrecision">'
    + '<circle class="staged-progress-ring" cx="18" cy="18" r="16"'
    + ' fill="none" stroke="currentColor" stroke-width="1.5" pathLength="100"'
    + ' stroke-dasharray="100 100" stroke-linecap="round"/></svg></span>';
}

export function setProgressRingPercent(root, percent) {
  const pie = root.querySelector('.staged-progress-pie');
  const full = percent === 100;
  pie.setAttribute('r', full ? '13' : '6.5');
  pie.setAttribute('fill', full ? 'currentColor' : 'none');
  pie.setAttribute('stroke', full ? 'none' : 'currentColor');
  pie.style.strokeDashoffset = String(100 - percent);
}
