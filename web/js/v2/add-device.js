// Add device: the Start URL form as a full-screen page over the current one, like the in-app
// browser, so its edge-back shows the live page below. It owns one history entry.
import { mountBackButton } from '../components/back-button.js';
import { registerEdgeBackLayer } from '../edge-back.js';
import { mountStartUrlForm } from './start-url-form.js';
import '../../css/back-button.css';

let current = null;

// underlaySelectors: the elements of the page below, drawn while swiping back.
export function openAddDevice({ underlaySelectors, onAdded }) {
  if (current) return;
  const root = document.createElement('div');
  root.className = 'add-device-page';
  root.innerHTML = '<span class="add-back"></span><div class="add-device-scroll"><div></div></div>';
  const form = mountStartUrlForm(root.lastChild.firstChild, { adding: true, onAdded });

  function close() {
    if (current !== root) return;
    current = null;
    removeEventListener('popstate', close);
    edgeBack.unregister();
    root.remove();
  }
  function back() {
    if (form.cancelScan()) return;
    close();
    history.back();
  }

  mountBackButton(root.firstChild, back);
  const edgeBack = registerEdgeBackLayer({
    navigateBack: back,
    foregroundSelectors: ['.add-device-page'],
    underlaySelectors,
  });
  document.body.appendChild(root);
  current = root;
  history.pushState({ addDevice: true }, '');
  addEventListener('popstate', close);
  edgeBack.activate();
}
