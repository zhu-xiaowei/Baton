import { downloadCancelled } from './download-task.js';

// Each WebView owns its queue; descriptors never consult navigation after enqueue.
export function createDownloadQueue(execute, onChange = () => {}) {
  const items = [];
  let active = null, sequence = 0;
  const notify = (item, event) => onChange(item, event);
  function pump() {
    if (active) return;
    const item = items.find(item => item.state === 'queued');
    if (!item) return;
    active = item;
    const controller = item.controller = new AbortController();
    item.state = 'preparing';
    notify(item, 'start');
    const update = patch => {
      if (active !== item || item.controller !== controller || controller.signal.aborted) return;
      Object.assign(item, patch);
      notify(item, 'progress');
    };
    const run = async () => execute(item.target, controller.signal, update);
    run().then(result => {
      if (!['saved', 'shared', 'started', 'ready', 'cancelled', 'queued', 'share_opened'].includes(result?.status)) throw new Error('Download result was not confirmed. Try again.');
      item.result = result;
      item.state = result.status === 'ready' ? 'ready' : result.status === 'cancelled' ? 'cancelled' : 'success';
    }).catch(error => {
      item.error = error;
      item.state = error.name === 'AbortError' ? 'cancelled' : 'error';
    }).finally(() => {
      active = null;
      item.controller = null;
      notify(item, 'finish');
      item.resolve(item);
      pump();
    });
  }
  function enqueue(target) {
    const item = { id: 'download-' + ++sequence, target: { ...target }, state: 'queued' };
    item.done = new Promise(resolve => { item.resolve = resolve; });
    items.push(item);
    notify(item, 'added');
    pump();
    return item;
  }
  function cancel(id) {
    const item = items.find(item => item.id === id);
    if (!item) return;
    if (item.state === 'queued') {
      item.state = 'cancelled';
      notify(item, 'finish');
      item.resolve(item);
    } else if (item === active && !item.controller.signal.aborted) {
      item.state = 'cancelling';
      item.controller.abort(downloadCancelled());
      notify(item, 'progress');
    }
  }
  return {
    enqueue, cancel,
    retry(id) {
      const item = items.find(item => item.id === id);
      if (!item || !['error', 'cancelled', 'ready'].includes(item.state)) return;
      Object.assign(item, { state: 'queued', result: null, error: null, progress: null, message: null });
      item.done = new Promise(resolve => { item.resolve = resolve; });
      // Retried items join the tail, behind work already accepted.
      items.splice(items.indexOf(item), 1);
      items.push(item);
      notify(item, 'added');
      pump();
      return item;
    },
    get pending() { return items.filter(item => ['queued', 'preparing', 'transferring', 'cancelling'].includes(item.state)).length; },
    cancelAll() {
      const pending = items.filter(item => ['queued', 'preparing', 'transferring', 'cancelling'].includes(item.state));
      for (const item of pending) cancel(item.id);
      return Promise.all(pending.map(item => item.done));
    },
  };
}
