export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const imageTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg' };

export function localImageFile(url, name) {
  const match = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match || match[2].length % 4 || !match[2].length) throw new Error('This image format cannot be exported.');
  const size = match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
  if (size > MAX_IMAGE_BYTES) throw new Error('Image export exceeds 32 MiB.');
  const header = atob(match[2].slice(0, 128));
  const mime = header.startsWith('\x89PNG') ? 'image/png' : header.startsWith('\xff\xd8\xff') ? 'image/jpeg'
    : header.startsWith('GIF8') ? 'image/gif' : header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP' ? 'image/webp' : match[1];
  return { url: url.replace(match[1], mime), name: name || `image.${imageTypes[mime]}`, contentType: mime, size };
}
