import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync(
  new URL('../../web/js/app.js', import.meta.url),
  'utf8',
);

test('project and session lists use breadcrumbs for page one and a footer for pagination', () => {
  assert.match(
    appSource,
    /function setBreadcrumbLoading\(loading\)[\s\S]*setBreadcrumbItemsLoading\([\s\S]*querySelectorAll\('#breadcrumb \.breadcrumb-nav a'\)/,
  );
  const paginationLoading = appSource.slice(
    appSource.indexOf('function setListLoading('),
    appSource.indexOf('function rememberActiveListScroll('),
  );
  assert.doesNotMatch(paginationLoading, /setBreadcrumbLoading/);
  assert.match(
    paginationLoading,
    /content\.insertAdjacentHTML\('beforeend', '<div class="loading-more">/,
  );
  assert.doesNotMatch(
    appSource,
    /loadPagedList[\s\S]*window\.__setTopSync\(true\)/,
  );
});
