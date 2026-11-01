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
  const reset = section.querySelector('.text-size-reset');
  const stops = section.querySelector('.text-size-stops');
  const defaultIndex = preference.levels.findIndex(level => level.scale === 1);
  let previewing = false;
  slider.max = String(preference.levels.length - 1);
  stops.replaceChildren(...preference.levels.map((_, index) => {
    const stop = document.createElement('i');
    if (index === defaultIndex) stop.className = 'is-default';
    return stop;
  }));
  const render = index => {
    slider.value = String(index);
    const level = preference.levels[index];
    const percent = `${Math.round(level.scale * 100)}%`;
    slider.setAttribute('aria-valuetext', index === defaultIndex ? `${percent} (default)` : percent);
    slider.style.setProperty('--range-progress', `${index / (preference.levels.length - 1) * 100}%`);
    value.textContent = percent;
    reset.disabled = index === defaultIndex;
  };
  const sync = () => {
    if (!previewing) render(preference.levels.findIndex(level => level.id === preference.get()));
  };
  slider.addEventListener('input', () => {
    previewing = true;
    render(Number(slider.value));
  });
  slider.addEventListener('pointerup', () => { previewing = false; });
  slider.addEventListener('change', () => {
    previewing = false;
    preference.set(preference.levels[Number(slider.value)].id);
    sync();
  });
  const cancelPreview = () => {
    previewing = false;
    sync();
  };
  slider.addEventListener('pointercancel', cancelPreview);
  slider.addEventListener('blur', cancelPreview);
  reset.addEventListener('click', () => {
    previewing = false;
    preference.set(preference.levels[defaultIndex].id);
    sync();
  });
  window.addEventListener(macos ? 'baton-macos-zoom-change' : 'baton-page-zoom-change', sync);
  sync();
}
