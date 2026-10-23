import { state } from '../state.js';
import {
  assembleLastFrame,
  assembleTextFrames,
  handleWsRpcMessage,
  requestWsRpc,
} from '../ws-rpc.js';

export function requestProjectFiles(operation, fields, options) {
  options = options || {};
  return requestWsRpc({
    action: 'project_files',
    operation: operation,
    projectHash: fields.projectHash,
    path: fields.path || '',
    ...(fields.cursor ? { cursor: fields.cursor } : {}),
    ...(fields.downloadToken ? { downloadToken: fields.downloadToken } : {}),
    device: fields.device ?? state.appState.device ?? '',
  }, {
    timeout: options.timeout,
    onProgress: options.onProgress,
    signal: options.signal,
    isCurrent: options.isCurrent,
    assemble: operation === 'read' ? assembleTextFrames : assembleLastFrame,
  });
}

export function handleProjectFilesMessage(message) {
  if (!message || message.action !== 'project_files') return false;
  handleWsRpcMessage(message);
  return true;
}
