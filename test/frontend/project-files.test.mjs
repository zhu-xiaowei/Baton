import assert from 'node:assert/strict';
import test from 'node:test';
import {
  joinProjectPath,
  normalizeProjectPath,
  parentProjectPath,
  projectBreadcrumbItems,
} from '../../web/js/project/paths.js';
import {
  handleProjectFilesMessage,
  requestProjectFiles,
} from '../../web/js/project/rpc.js';

test('preview file reads use the existing protocol and assemble out-of-order text frames', async () => {
  let payload;
  globalThis.window = { wsSendReliable(value) { payload = value; } };
  try {
    const pending = requestProjectFiles('read', {
      projectHash: 'project', path: '/preview.html',
    });
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
    handleProjectFilesMessage({
      action: 'project_files', operation: 'read', requestId: payload.requestId,
      ok: true, key: 'large.log', size: 400 * 1024,
    });
    assert.equal('content' in await uploaded, false);
  } finally {
    delete globalThis.window;
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

test('project file requests use a UUID and settle only their matching response', async () => {
  var payload;
  globalThis.window = {
    wsSendReliable(value) {
      payload = value;
    },
  };
  const pending = requestProjectFiles('list', {
    projectHash: 'project',
    path: '',
  });
  assert.match(
    payload.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(handleProjectFilesMessage({
    action: 'project_files',
    operation: 'list',
    requestId: 'another-request',
    ok: true,
    entries: [],
  }), true);
  handleProjectFilesMessage({
    action: 'project_files',
    operation: 'list',
    requestId: payload.requestId,
    ok: true,
    entries: [{ name: 'web', type: 'directory' }],
  });
  const response = await pending;
  assert.deepEqual(response.entries, [{ name: 'web', type: 'directory' }]);
  delete globalThis.window;
});

test('project file reads assemble out-of-order chunks before resolving once', async () => {
  var payload;
  globalThis.window = {
    wsSendReliable(value) {
      payload = value;
    },
  };
  var settled = false;
  const pending = requestProjectFiles('read', {
    projectHash: 'project',
    path: 'web/js/app.js',
  }).then(function (response) {
    settled = true;
    return response;
  });

  handleProjectFilesMessage({
    action: 'project_files',
    operation: 'read',
    requestId: payload.requestId,
    sequence: 1,
    content: 'world',
    complete: true,
    ok: true,
    key: 'file.js',
    path: '/project/web/js/app.js',
  });
  await Promise.resolve();
  assert.equal(settled, false);

  handleProjectFilesMessage({
    action: 'project_files',
    operation: 'read',
    requestId: payload.requestId,
    sequence: 0,
    content: 'hello ',
    complete: false,
    ok: true,
  });
  const response = await pending;
  assert.equal(response.content, 'hello world');
  assert.equal(response.complete, true);
  assert.equal(response.key, 'file.js');
  delete globalThis.window;
});
