import fs from 'fs';
import { StringDecoder } from 'string_decoder';

const DEFAULT_CHUNK_SIZE = 64 * 1024;

export function scanJsonlLines(filePath, onLine, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const buffer = Buffer.allocUnsafe(chunkSize);
  const decoder = new StringDecoder('utf8');
  const fd = fs.openSync(filePath, 'r');
  let pending = [];
  let lineNumber = 0;

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      let newline;
      while ((newline = text.indexOf('\n', start)) !== -1) {
        pending.push(text.slice(start, newline));
        let line = pending.length === 1 ? pending[0] : pending.join('');
        if (line.endsWith('\r')) line = line.slice(0, -1);
        onLine(line, lineNumber++);
        pending = [];
        start = newline + 1;
      }
      if (start < text.length) pending.push(text.slice(start));
    }

    const tail = decoder.end();
    if (tail) pending.push(tail);
    if (pending.length > 0) {
      let line = pending.length === 1 ? pending[0] : pending.join('');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line, lineNumber++);
    }
    return lineNumber;
  } finally {
    fs.closeSync(fd);
  }
}
