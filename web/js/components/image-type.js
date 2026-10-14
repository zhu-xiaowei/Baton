export const IMAGE_MIME_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
};

export function imageMimeType(path) {
  const extension = String(path || '').split(/[?#]/, 1)[0].split('.').pop().toLowerCase();
  return Object.hasOwn(IMAGE_MIME_TYPES, extension) ? IMAGE_MIME_TYPES[extension] : '';
}
