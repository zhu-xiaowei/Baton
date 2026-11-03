import { state } from '../state.js';
import { requestProjectFiles } from './rpc.js';

const homes = new Map();

// The Bridge resolves the home folder's own project hash back to `~`, so it works as a project root.
export function homeProject(device = state.appState.device) {
  const key = JSON.stringify([state.SERVER, device]);
  if (!homes.has(key)) {
    homes.set(key, (async () => {
      await window.loadViewerLibs();
      window.connectWs();
      const response = await requestProjectFiles('browse', { path: '~', device }, { timeout: 10000 });
      if (!response.path) throw new Error('Home folder not found');
      return { hash: response.path.replace(/[^a-zA-Z0-9-]/g, '-'), name: '~' };
    })().catch(error => {
      homes.delete(key);
      throw error;
    }));
  }
  return homes.get(key);
}
