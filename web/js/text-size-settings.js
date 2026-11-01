import '../css/text-size.css';
import { initMacosZoom } from './macos-zoom.js';

export function mountTextSizeSettings() {
  const macos = initMacosZoom();
  const preference = macos || window.batonPageZoom;
  const section = document.getElementById('textSizeSettings');
  if (!preference?.enabled || !section) return;
  section.hidden = false;
  const slider = section.querySelector('input');
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
    if (document.activeElement === slider) slider.scrollIntoView({ block: 'nearest' });
  };
  slider.addEventListener('input', () => preference.set(preference.levels[Number(slider.value)].id));
  window.addEventListener(macos ? 'baton-macos-zoom-change' : 'baton-page-zoom-change', sync);
  sync();
}
