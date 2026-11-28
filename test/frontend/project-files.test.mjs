import assert from 'node:assert/strict';
import test from 'node:test';
import {
  joinProjectPath,
  normalizeProjectPath,
  parentProjectPath,
  projectBreadcrumbItems,
} from '../../web/js/project/paths.js';
import { requestProjectFiles } from '../../web/js/project/rpc.js';
import { mockBridgeFrames } from './bridge-frames-mock.mjs';

test('preview file reads use the existing protocol and assemble out-of-order text frames', async () => {
  const bridge = mockBridgeFrames();
  const handleProjectFilesMessage = bridge.answer;
  {
    const pending = requestProjectFiles('read', {
      projectHash: 'project', path: '/preview.html',
    });
    let payload = bridge.requests[0];
    assert.equal(payload.operation, 'read');
    assert.equal(payload.projectHash, 'project');
    for (const sequence of [1, 0]) {
      handleProjectFilesMessage({
        action: 'project_files', operation: 'read', requestId: payload.requestId,
        sequence, content: sequence ? '</p>' : '<p>Preview', complete: sequence === 1, ok: true,
      });
    }
    assert.equal((await pending).content, '<p>Preview</p>');

    const uploaded = requestProjectFiles('read', { projectHash: 'project', path: '/large.log' });
    payload = bridge.requests[1];
    handleProjectFilesMessage({
      action: 'project_files', operation: 'read', requestId: payload.requestId,
      ok: true, key: 'large.log', size: 400 * 1024,
    });
    assert.equal('content' in await uploaded, false);
  }
});

test('project file paths stay relative and navigate one directory at a time', () => {
  assert.equal(normalizeProjectPath('/web//js/'), 'web/js');
  assert.equal(joinProjectPath('web/js', 'components'), 'web/js/components');
  assert.equal(parentProjectPath('web/js/components'), 'web/js');
  assert.equal(parentProjectPath('web'), '');
});

test('project breadcrumb items retain every intermediate directory path', () => {
  assert.deepEqual(projectBreadcrumbItems('agentpeek', 'web/js/project'), [
    { label: 'agentpeek', value: '' },
    { label: 'web', value: 'web' },
    { label: 'js', value: 'web/js' },
    { label: 'project', value: 'web/js/project' },
  ]);
});
