export function normalizeProjectPath(value) {
  var output = [];
  String(value || '').replaceAll('\\', '/').split('/').forEach(function (part) {
    if (!part || part === '.') return;
    if (part === '..') output.pop();
    else output.push(part);
  });
  return output.join('/');
}

export function joinProjectPath(parent, child) {
  return normalizeProjectPath((parent ? parent + '/' : '') + child);
}

export function parentProjectPath(value) {
  var parts = normalizeProjectPath(value).split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export function projectBreadcrumbItems(projectName, value) {
  var items = [{ label: projectName || 'Project', value: '' }];
  var current = '';
  normalizeProjectPath(value).split('/').filter(Boolean).forEach(function (part) {
    current = joinProjectPath(current, part);
    items.push({ label: part, value: current });
  });
  return items;
}

// Inside the project root a path stays relative; outside it is absolute ('/a/b' or 'C:/a').
export function isAbsoluteFilesPath(value) {
  return /^(?:\/|[a-z]:[\\/])/i.test(value || '');
}

function absolutePath(value) {
  var text = String(value).replaceAll('\\', '/');
  var drive = /^[a-z]:/i.test(text) ? text.slice(0, 2) : '';
  return drive + '/' + normalizeProjectPath(text.slice(drive.length));
}

function relativeToRoot(root, value) {
  if (value === root) return '';
  var prefix = root.endsWith('/') ? root : root + '/';
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

export function canonicalFilesPath(root, value) {
  if (!isAbsoluteFilesPath(value)) return normalizeProjectPath(value);
  var path = absolutePath(value);
  var relative = root ? relativeToRoot(absolutePath(root), path) : null;
  return relative == null ? path : relative;
}

export function joinFilesPath(root, parent, child) {
  return canonicalFilesPath(root, isAbsoluteFilesPath(parent) ? parent + '/' + child : joinProjectPath(parent, child));
}

// The full path from the filesystem root; the project root item is the scroll anchor.
export function filesBreadcrumbItems(name, root, value) {
  if (!root) return projectBreadcrumbItems(name, value);
  root = absolutePath(root);
  var path = isAbsoluteFilesPath(value) ? absolutePath(value) : absolutePath(root + '/' + value);
  var drive = /^[a-z]:/i.test(path) ? path.slice(0, 2) : '';
  var items = [{ label: drive || '/', value: drive + '/', root: !drive }];
  var current = drive;
  normalizeProjectPath(path.slice(drive.length)).split('/').filter(Boolean).forEach(function (part) {
    current += '/' + part;
    items.push({ label: part, value: current });
  });
  items.forEach(function (item) {
    var relative = relativeToRoot(root, item.value);
    if (relative == null) return;
    item.value = relative;
    if (!relative) Object.assign(item, { label: name || item.label, anchor: true });
  });
  return items;
}
