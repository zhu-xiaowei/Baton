import { state } from '../state.js';
import { assembleLastFrame, assembleTextFrames, requestWsRpc } from '../ws-rpc.js';

export function requestProjectFiles(operation, fields, options) {
  options = options || {};
  return requestWsRpc({
    action: 'project_files',
    operation: operation,
    projectHash: fields.projectHash,
    path: fields.path || '',
    ...(fields.cursor ? { cursor: fields.cursor } : {}),
    device: fields.device ?? state.appState.device ?? '',
    files: 2, // opens sealed videos and large files (bridge/project/files.mjs)
  }, {
    timeout: options.timeout,
    onProgress: options.onProgress,
    assemble: operation === 'read' ? assembleTextFrames : assembleLastFrame,
  });
}
