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
    device: fields.device ?? state.appState.device ?? '',
  }, {
    timeout: options.timeout,
    onProgress: options.onProgress,
    assemble: operation === 'read' ? assembleTextFrames : assembleLastFrame,
  });
}

export function handleProjectFilesMessage(message) {
  if (!message || message.action !== 'project_files') return false;
  handleWsRpcMessage(message);
  return true;
}
