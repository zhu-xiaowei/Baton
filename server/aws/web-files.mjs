// The web app's files as the Python server served them: Starlette's StaticFiles(html=True) and
// FileResponse (ETag, Last-Modified, 304, Range) with the cache headers of #191.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { response, text } from '../core/http.mjs';
import { HTTPError, floatRepr, pyStrip, randomHex } from '../core/py.mjs';

// mimetypes.guess_type with Python 3.12's built-in table (the image has no /etc/mime.types).
const TYPES = Object.fromEntries('3g2:audio/3gpp2,3gp:audio/3gpp,3gpp:audio/3gpp,3gpp2:audio/3gpp2,a:application/octet-stream,aac:audio/aac,adts:audio/aac,ai:application/postscript,aif:audio/x-aiff,aifc:audio/x-aiff,aiff:audio/x-aiff,ass:audio/aac,au:audio/basic,avi:video/x-msvideo,avif:image/avif,bat:text/plain,bcpio:application/x-bcpio,bin:application/octet-stream,bmp:image/bmp,c:text/plain,cdf:application/x-netcdf,cpio:application/x-cpio,csh:application/x-csh,css:text/css,csv:text/csv,dll:application/octet-stream,doc:application/msword,dot:application/msword,dvi:application/x-dvi,eml:message/rfc822,eps:application/postscript,etx:text/x-setext,exe:application/octet-stream,gif:image/gif,gtar:application/x-gtar,h:text/plain,h5:application/x-hdf5,hdf:application/x-hdf,heic:image/heic,heif:image/heif,htm:text/html,html:text/html,ico:image/vnd.microsoft.icon,ief:image/ief,jpe:image/jpeg,jpeg:image/jpeg,jpg:image/jpeg,js:text/javascript,json:application/json,ksh:text/plain,latex:application/x-latex,loas:audio/aac,m1v:video/mpeg,m3u:application/vnd.apple.mpegurl,m3u8:application/vnd.apple.mpegurl,man:application/x-troff-man,markdown:text/markdown,md:text/markdown,me:application/x-troff-me,mht:message/rfc822,mhtml:message/rfc822,mif:application/x-mif,mjs:text/javascript,mov:video/quicktime,movie:video/x-sgi-movie,mp2:audio/mpeg,mp3:audio/mpeg,mp4:video/mp4,mpa:video/mpeg,mpe:video/mpeg,mpeg:video/mpeg,mpg:video/mpeg,ms:application/x-troff-ms,n3:text/n3,nc:application/x-netcdf,nq:application/n-quads,nt:application/n-triples,nws:message/rfc822,o:application/octet-stream,obj:application/octet-stream,oda:application/oda,opus:audio/opus,p12:application/x-pkcs12,p7c:application/pkcs7-mime,pbm:image/x-portable-bitmap,pdf:application/pdf,pfx:application/x-pkcs12,pgm:image/x-portable-graymap,pl:text/plain,png:image/png,pnm:image/x-portable-anymap,pot:application/vnd.ms-powerpoint,ppa:application/vnd.ms-powerpoint,ppm:image/x-portable-pixmap,pps:application/vnd.ms-powerpoint,ppt:application/vnd.ms-powerpoint,ps:application/postscript,pwz:application/vnd.ms-powerpoint,py:text/x-python,pyc:application/x-python-code,pyo:application/x-python-code,qt:video/quicktime,ra:audio/x-pn-realaudio,ram:application/x-pn-realaudio,ras:image/x-cmu-raster,rdf:application/xml,rgb:image/x-rgb,roff:application/x-troff,rst:text/x-rst,rtx:text/richtext,sgm:text/x-sgml,sgml:text/x-sgml,sh:application/x-sh,shar:application/x-shar,snd:audio/basic,so:application/octet-stream,src:application/x-wais-source,srt:text/plain,sv4cpio:application/x-sv4cpio,sv4crc:application/x-sv4crc,svg:image/svg+xml,swf:application/x-shockwave-flash,t:application/x-troff,tar:application/x-tar,tcl:application/x-tcl,tex:application/x-tex,texi:application/x-texinfo,texinfo:application/x-texinfo,tif:image/tiff,tiff:image/tiff,tr:application/x-troff,trig:application/trig,tsv:text/tab-separated-values,txt:text/plain,ustar:application/x-ustar,vcf:text/x-vcard,vtt:text/vtt,wasm:application/wasm,wav:audio/x-wav,webm:video/webm,webmanifest:application/manifest+json,wiz:application/msword,wsdl:application/xml,xbm:image/x-xbitmap,xlb:application/vnd.ms-excel,xls:application/vnd.ms-excel,xml:text/xml,xpdl:application/xml,xpm:image/x-xpixmap,xsl:application/xml,xwd:image/x-xwindowdump,zip:application/zip'
  .split(',').map((entry) => { const split = entry.indexOf(':'); return [`.${entry.slice(0, split)}`, entry.slice(split + 1)]; }));
const SUFFIXES = { '.svgz': '.svg.gz', '.tgz': '.tar.gz', '.taz': '.tar.gz', '.tz': '.tar.gz', '.tbz2': '.tar.bz2', '.txz': '.tar.xz' };
function guessType(file) {
  let ext = path.extname(file);
  while (SUFFIXES[ext.toLowerCase()]) {
    file = file.slice(0, -ext.length) + SUFFIXES[ext.toLowerCase()];
    ext = path.extname(file);
  }
  if (['.gz', '.Z', '.bz2', '.xz', '.br'].includes(ext)) ext = path.extname(file.slice(0, -ext.length));
  return TYPES[ext.toLowerCase()];
}
// Vite's hashed chunks never change; HTML must revalidate, or a stale cached index.html
// requests chunks the next deploy deleted. Other files keep the browser's default.
const HASHED = /^assets\/[^/]+-[\p{L}\p{N}_-]{8}\.(js|css)\n?$/u;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function normpath(value) {
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/') || '.';
}

async function lookup(directory, relative) {
  if (relative.startsWith('/') || relative.startsWith('\\')) return null;
  const full = path.resolve(directory, relative);
  if (full !== directory && !full.startsWith(directory + path.sep)) return null;
  try {
    return [full, await fs.stat(full, { bigint: true })];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new HTTPError(401, 'Unauthorized');
    if (error.code === 'ENAMETOOLONG' || error.code === 'ERR_INVALID_ARG_VALUE' || error.code === 'ERR_INVALID_ARG_TYPE') {
      throw new HTTPError(404, 'Not Found');
    }
    throw error;
  }
}

// email.utils.parsedate for HTTP dates (RFC 1123, RFC 850, asctime); the zone is ignored, as there.
function parsedate(value) {
  let match = /^\s*(?:[A-Za-z]+,?\s*)?(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*[\s-]+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value);
  const asctime = !match && /^\s*[A-Za-z]{3},?\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(\d{2,4})/.exec(value);
  if (asctime) match = [, asctime[2], asctime[1], asctime[6], asctime[3], asctime[4], asctime[5]];
  const month = match && MONTHS.findIndex((name) => name.toLowerCase() === match[2].toLowerCase());
  if (!match || month < 0) return null;
  let year = Number(match[3]);
  if (match[3].length <= 2) year += year > 68 ? 1900 : 2000;
  return [year, month + 1, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0)];
}
const later = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

const pyInt = (value) => (/^[+-]?\d+(?:_\d+)*$/.test(value) ? Number(value.replace(/_/g, '')) : NaN);

// FileResponse's Range handling: [] for a plain reply, or the ranges; throws a reply for a bad header.
function parseRanges(header, size) {
  const split = header.indexOf('=');
  if (split < 0) throw text('Malformed range header.', 400);
  if (pyStrip(header.slice(0, split)).toLowerCase() !== 'bytes') throw text('Only support bytes range', 400);
  const spec = header.slice(split + 1);
  if (spec.split(',').length > 100) return [];
  const ranges = [];
  for (let part of spec.split(',')) {
    part = pyStrip(part);
    if (!part || part === '-' || !part.includes('-')) continue;
    const dash = part.indexOf('-');
    const [first, last] = [pyStrip(part.slice(0, dash)), pyStrip(part.slice(dash + 1))];
    const start = first ? pyInt(first) : Math.max(size - pyInt(last), 0);
    const end = first && last && pyInt(last) < size ? pyInt(last) + 1 : size;
    if (Number.isNaN(start) || Number.isNaN(end) || (first && last && Number.isNaN(pyInt(last)))) continue;
    ranges.push([start, end]);
  }
  if (!ranges.length) throw text('Range header: range must be requested', 400);
  if (ranges.some(([start]) => !(start >= 0 && start < size))) throw text('', 416, { 'content-range': `bytes */${size}` });
  if (ranges.some(([start, end]) => start >= end)) throw text('Range header: start must be less than end', 400);
  if (ranges.length === 1) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [ranges[0]];
  for (const [start, end] of ranges.slice(1)) {
    const lastRange = merged.at(-1);
    if (start <= lastRange[1]) lastRange[1] = Math.max(lastRange[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

async function fileResponse(full, stat, context, status = 200, check = true) {
  const size = Number(stat.size);
  const mtime = Number(stat.mtimeNs / 1_000_000_000n) + Number(stat.mtimeNs % 1_000_000_000n) * 1e-9;
  const etagBase = new TextEncoder().encode(`${floatRepr(mtime)}-${size}`);
  const md5 = createHash('md5').update(etagBase).digest('hex');
  const type = guessType(full) ?? 'application/octet-stream';
  const headers = { 'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type, 'accept-ranges': 'bytes',
    'content-length': String(size), 'last-modified': new Date(Math.floor(mtime) * 1000).toUTCString(), etag: `"${md5}"` };
  const request = context.headers;
  if (check) {
    const match = request.get('if-none-match');
    if (match) {
      if (pyStrip(match) === '*' || match.split(',').map((tag) => pyStrip(tag).replace(/^W\//, '')).includes(headers.etag)) {
        return { status: 304, headers: { etag: headers.etag }, body: new Uint8Array() };
      }
    } else if (request.get('if-modified-since') !== null) {
      const since = parsedate(request.get('if-modified-since'));
      const modified = parsedate(headers['last-modified']);
      if (since && modified && later(since, modified)) return { status: 304, headers: { etag: headers.etag }, body: new Uint8Array() };
    }
  }
  return { status, headers, file: full, size };
}

// Reads the file once the cache headers are set; a Range reply replaces them, as FileResponse does.
async function send(reply, context) {
  if (!reply.file) return reply;
  const { file, size, ...rest } = reply;
  const head = context.method === 'HEAD';
  const range = context.headers.get('range');
  const ifRange = context.headers.get('if-range');
  const useRange = rest.status === 200 && range !== null
    && (ifRange === null || (!ifRange.startsWith('W/') && (ifRange === rest.headers['last-modified'] || ifRange === rest.headers.etag)));
  let ranges = [];
  if (useRange) {
    try {
      ranges = parseRanges(range, size);
    } catch (thrown) {
      if (thrown.body instanceof Uint8Array) return thrown;
      throw thrown;
    }
  }
  const bytes = head ? new Uint8Array() : new Uint8Array(await fs.readFile(file));
  if (ranges.length === 1) {
    const [[start, end]] = ranges;
    return { status: 206, headers: { ...rest.headers, 'content-range': `bytes ${start}-${end - 1}/${size}`, 'content-length': String(end - start) },
      body: bytes.subarray(start, end) };
  }
  if (ranges.length > 1) {
    const boundary = randomHex(13);
    const type = rest.headers['content-type'];
    const parts = [];
    for (const [start, end] of ranges) {
      parts.push(new TextEncoder().encode(`--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${start}-${end - 1}/${size}\r\n\r\n`),
        bytes.subarray(start, end), new TextEncoder().encode('\r\n'));
    }
    parts.push(new TextEncoder().encode(`--${boundary}--`));
    const length = ranges.reduce((sum, [start, end]) => sum + String(start).length + String(end - 1).length
      + 49 + boundary.length + type.length + String(size).length + end - start, 0) + 4 + boundary.length;
    return { status: 206, headers: { ...rest.headers, 'content-type': `multipart/byteranges; boundary=${boundary}`, 'content-length': String(length) },
      body: head ? new Uint8Array() : new Uint8Array(await new Blob(parts).arrayBuffer()) };
  }
  return { ...rest, body: bytes };
}

// os.path.normpath(os.path.join(*path.split("/")))
function routePath(value) {
  let joined = '';
  for (const part of value.split('/')) joined = !joined || joined.endsWith('/') ? joined + part : `${joined}/${part}`;
  return normpath(joined);
}

async function staticFile(context, directory, relative) {
  if (!['GET', 'HEAD'].includes(context.method)) throw new HTTPError(405, 'Method Not Allowed', { allow: 'GET, HEAD' });
  let found = await lookup(directory, relative);
  if (found && found[1].isFile()) return fileResponse(...found, context);
  if (found && found[1].isDirectory()) {
    const index = await lookup(directory, path.posix.join(relative, 'index.html'));
    if (index && index[1].isFile()) {
      if (!context.path.endsWith('/')) {
        const proto = context.scheme;
        const query = context.url.search;
        return response(307, '', null, { location: `${proto}://${context.headers.get('host') ?? ''}${context.path}/${query}` });
      }
      return fileResponse(...index, context);
    }
  }
  found = await lookup(directory, '404.html');
  if (found && found[1].isFile()) return fileResponse(...found, context, 404, false);
  throw new HTTPError(404, 'Not Found');
}

export function web(directory) {
  return async (context) => {
    const relative = routePath(context.path);
    const reply = await staticFile(context, directory, relative);
    if (HASHED.test(relative)) {
      if ([200, 304].includes(reply.status)) reply.headers['cache-control'] = 'public, max-age=31536000, immutable';
    } else if (relative === '.' || relative.endsWith('.html')) {
      reply.headers['cache-control'] = 'no-cache';
    }
    return send(reply, context);
  };
}
