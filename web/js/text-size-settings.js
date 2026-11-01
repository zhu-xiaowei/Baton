import '../css/text-size.css';
import { initMacosZoom } from './macos-zoom.js';
import { layoutPixels } from './page-zoom.js';

export function mountTextSizeSettings() {
  const macos = initMacosZoom();
  const preference = macos || window.batonPageZoom;
  const section = document.getElementById('textSizeSettings');
  if (!preference?.enabled || !section) return;
  section.hidden = false;
  const slider = section.querySelector('input');
  const scroller = section.parentElement;
  const paddingTop = scroller.style.paddingTop;
  const paddingBottom = scroller.style.paddingBottom;
  const value = section.querySelector('.text-size-value');
  const stops = section.querySelector('.text-size-stops');
  slider.max = String(preference.levels.length - 1);
  stops.replaceChildren(...preference.levels.map(() => document.createElement('i')));
  const sync = () => {
    const index = preference.levels.findIndex(level => level.id === preference.get());
    slider.value = String(index);
    const level = preference.levels[index];
    const percent = `${Math.round(level.scale * 100)}%`;
    slider.setAttribute('aria-valuetext', level.scale === 1 ? `${percent} (default)` : percent);
    slider.style.setProperty('--range-progress', `${index / (preference.levels.length - 1) * 100}%`);
    value.textContent = percent;
  };
  let restorePosition;
  window.addEventListener('resize', () => restorePosition?.());
  slider.addEventListener('input', () => {
    const center = () => {
      const rect = slider.getBoundingClientRect();
      return (rect.top + rect.bottom) / 2;
    };
    // Use a viewport fraction because native zoom also changes viewport coordinates.
    const position = center() / window.innerHeight;
    const restore = () => {
      scroller.style.paddingTop = paddingTop;
      scroller.style.paddingBottom = paddingBottom;
      const target = scroller.scrollTop + layoutPixels(center() - position * window.innerHeight);
      const last = [...scroller.children].reverse().find(child => child.getClientRects().length);
      const style = getComputedStyle(scroller);
      const maxScroll = scroller.scrollTop
        + layoutPixels(last.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top)
        + parseFloat(getComputedStyle(last).marginBottom) + parseFloat(style.paddingBottom) - scroller.clientHeight;
      // Leave enough scroll room at either edge, including when all content fits.
      if (target < 0) {
        scroller.style.paddingTop = `${parseFloat(style.paddingTop) - target}px`;
      } else if (target > 0 && target > maxScroll) {
        scroller.style.paddingBottom = `${parseFloat(style.paddingBottom) + target - maxScroll}px`;
      }
      scroller.scrollTop += layoutPixels(center() - position * window.innerHeight);
    };
    restorePosition = restore;
    preference.set(preference.levels[Number(slider.value)].id);
    restore();
    preference.settled().then(() => requestAnimationFrame(() => {
      if (restorePosition !== restore) return;
      restore();
      restorePosition = null;
    }));
  });
  window.addEventListener(macos ? 'baton-macos-zoom-change' : 'baton-page-zoom-change', sync);
  sync();
}
