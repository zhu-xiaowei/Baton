import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { BusinessError, request } from '@kit.BasicServicesKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { JsChannel } from './JsChannel';

// Same limits as the Tauri file-download plugin (HTTPS only, no URL credentials,
// sanitized name, 512 MB, one at a time). The public Downloads folder needs a
// restricted ACL, so bytes go to the app cache and the system save dialog writes them out.

// A class, not an interface: ArkTS only casts parsed JSON onto a declared class.
class DownloadArgs {
  id: number = 0;
  url: string = '';
  name: string = '';
}

// Bytes made in the page (Mermaid PNG export), base64 without the data: prefix.
class SaveArgs {
  id: number = 0;
  name: string = '';
  data: string = '';
}

const MAX_BYTES: number = 512 * 1024 * 1024;
const CACHE_DIR: string = 'baton-download';
const STALL_MS: number = 60000;
const TOO_LARGE: string = 'File exceeds 512 MB';
const FAILED: string = 'Download failed. Check your connection and available storage.';
const STALLED: string = 'Download stalled. Keep Baton in the foreground and try again.';
const CANCELLED: string = 'cancelled';

// Keep only the last path segment, drop characters no file system accepts, and
// bound the length so the save dialog always gets a usable name.
function safeName(raw: string): string {
  let name: string = raw.replace(/\\/g, '/');
  const slash: number = name.lastIndexOf('/');
  if (slash >= 0) {
    name = name.substring(slash + 1);
  }
  name = name.replace(/[\u0000-\u001F\u007F<>:"|?*]/g, '_');
  name = name.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  if (name.length <= 120) {
    return name;
  }
  const dot: number = name.lastIndexOf('.');
  const extension: string = dot > 0 ? name.substring(dot, dot + 21) : '';
  return name.substring(0, 120 - extension.length) + extension;
}

function extensionOf(name: string): string {
  const dot: number = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return '';
  }
  const extension: string = name.substring(dot + 1, dot + 17);
  return /^[A-Za-z0-9]+$/.test(extension) ? '.' + extension.toLowerCase() : '';
}

// https, a host, and no user:password — matches the Tauri plugins' check.
function isHttpsUrl(url: string): boolean {
  const match: RegExpMatchArray | null = url.match(/^https:\/\/([^/?#]+)/);
  return match !== null && !match[1].includes('@');
}

function isCancel(error: BusinessError): boolean {
  return error.code === 13900020 || /cancel/i.test(`${error.message}`);
}

function parseArgs(argsJson: string): DownloadArgs | null {
  try {
    return JSON.parse(argsJson) as DownloadArgs;
  } catch (e) {
    return null;
  }
}

function parseSaveArgs(argsJson: string): SaveArgs | null {
  try {
    return JSON.parse(argsJson) as SaveArgs;
  } catch (e) {
    return null;
  }
}

export class DownloadBridge {
  channel: JsChannel | null = null;
  context: common.Context | null = null;
  private busy: boolean = false;
  private task: request.agent.Task | null = null;
  private percent: number = -1;
  private abort: (() => void) | null = null;
  // A cancel can arrive before the task exists, while abort is still null.
  private cancelRequested: boolean = false;

  download(argsJson: string): void {
    const args: DownloadArgs | null = parseArgs(argsJson);
    if (args === null) {
      return;
    }
    const id: number = args.id;
    const context: common.Context | null = this.context;
    if (this.busy) {
      this.fail(id, 'A download is already in progress');
      return;
    }
    if (context === null) {
      this.fail(id, 'Downloads are unavailable');
      return;
    }
    if (!isHttpsUrl(`${args.url}`)) {
      this.fail(id, 'Downloads require an HTTPS URL');
      return;
    }
    const name: string = safeName(`${args.name}`);
    if (name.length === 0) {
      this.fail(id, 'Invalid filename');
      return;
    }
    this.busy = true;
    this.percent = -1;
    this.cancelRequested = false;
    this.run(context, id, `${args.url}`, name);
  }

  // Same save dialog as download(), without a transfer: the bytes are already here.
  save(argsJson: string): void {
    const args: SaveArgs | null = parseSaveArgs(argsJson);
    if (args === null) {
      return;
    }
    const id: number = args.id;
    const context: common.Context | null = this.context;
    if (this.busy) {
      this.fail(id, 'A download is already in progress');
      return;
    }
    if (context === null) {
      this.fail(id, 'Downloads are unavailable');
      return;
    }
    const data: string = `${args.data}`;
    if (data.length / 4 * 3 > MAX_BYTES) {
      this.fail(id, TOO_LARGE);
      return;
    }
    const name: string = safeName(`${args.name}`);
    if (name.length === 0) {
      this.fail(id, 'Invalid filename');
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = new util.Base64Helper().decodeSync(data);
    } catch (e) {
      this.fail(id, 'Invalid file data');
      return;
    }
    this.busy = true;
    this.writeGenerated(context, id, name, bytes);
  }

  // Closing the preview stops the transfer. Once the save dialog is open it is the user's.
  cancel(): void {
    this.cancelRequested = this.busy;
    const abort: (() => void) | null = this.abort;
    this.abort = null;
    if (abort !== null) {
      abort();
    }
  }

  release(): void {
    this.abort = null;
    this.stopTask();
    this.busy = false;
  }

  private async run(context: common.Context, id: number, url: string, name: string): Promise<void> {
    const cacheName: string = `${Date.now()}${extensionOf(name)}`;
    const cachePath: string = `${context.cacheDir}/${CACHE_DIR}/${cacheName}`;
    try {
      fs.mkdirSync(`${context.cacheDir}/${CACHE_DIR}`, true);
    } catch (e) {
      // Already there, or creation fails and the download below reports it.
    }
    let stallTimer: number = -1;
    try {
      const config: request.agent.Config = {
        action: request.agent.Action.DOWNLOAD,
        url: url,
        title: name,
        mode: request.agent.Mode.FOREGROUND,
        network: request.agent.Network.ANY,
        saveas: `./${CACHE_DIR}/${cacheName}`,
        overwrite: true
      };
      const task: request.agent.Task = await request.agent.create(context, config);
      this.task = task;
      if (this.cancelRequested) {
        throw new Error(CANCELLED);
      }
      await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
        // A foreground task that sat in the background is paused rather than
        // failed, and emits neither 'completed' nor 'failed' — without this
        // watchdog the frontend would wait on it forever.
        this.abort = () => reject(new Error(CANCELLED));
        const arm = (): void => {
          if (stallTimer !== -1) {
            clearTimeout(stallTimer);
          }
          stallTimer = setTimeout(() => reject(new Error(STALLED)), STALL_MS);
        };
        task.on('progress', (progress: request.agent.Progress) => {
          const total: number = progress.sizes.length > 0 ? progress.sizes[0] : -1;
          if (progress.processed > MAX_BYTES || total > MAX_BYTES) {
            reject(new Error(TOO_LARGE));
            return;
          }
          arm();
          if (total > 0) {
            this.report(id, Math.min(100, Math.floor(progress.processed / total * 100)));
          }
        });
        task.on('completed', () => resolve());
        task.on('failed', () => reject(new Error(FAILED)));
        arm();
        task.start().catch((error: BusinessError) => reject(new Error(`${error.message}`)));
      });
      this.abort = null;
      clearTimeout(stallTimer);
      stallTimer = -1;
      this.report(id, 100);
      const uri: string | null = await this.pickDestination(context, name);
      if (uri === null) {
        this.channel?.resolve(id, '{"status":"cancelled"}');
        return;
      }
      const destination: fs.File = fs.openSync(uri, fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      try {
        await fs.copyFile(cachePath, destination.fd);
      } finally {
        fs.closeSync(destination);
      }
      this.channel?.resolve(id, '{"status":"saved_as"}');
    } catch (error) {
      const message: string = `${(error as BusinessError).message}`;
      if (message === CANCELLED) {
        this.channel?.resolve(id, '{"status":"cancelled"}');
      } else {
        this.fail(id, message.length > 0 ? message : FAILED);
      }
    } finally {
      this.abort = null;
      if (stallTimer !== -1) {
        clearTimeout(stallTimer);
      }
      this.busy = false;
      this.stopTask();
      try {
        await fs.unlink(cachePath);
      } catch (e) {
        // Never created, or already copied out of the cache.
      }
    }
  }

  private async writeGenerated(context: common.Context, id: number, name: string, bytes: Uint8Array): Promise<void> {
    try {
      const uri: string | null = await this.pickDestination(context, name);
      if (uri === null) {
        this.channel?.resolve(id, '{"status":"cancelled"}');
        return;
      }
      const destination: fs.File = fs.openSync(uri, fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      try {
        await fs.write(destination.fd, bytes.buffer);
      } finally {
        fs.closeSync(destination);
      }
      this.channel?.resolve(id, '{"status":"saved_as"}');
    } catch (error) {
      const message: string = `${(error as BusinessError).message}`;
      this.fail(id, message.length > 0 ? message : FAILED);
    } finally {
      this.busy = false;
    }
  }

  // The system save dialog owns the destination (it opens on Downloads with the
  // name prefilled); null means the user cancelled it.
  private async pickDestination(context: common.Context, name: string): Promise<string | null> {
    let uris: string[] = [];
    try {
      const options: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
      options.newFileNames = [name];
      uris = await new picker.DocumentViewPicker(context).save(options);
    } catch (error) {
      if (!isCancel(error as BusinessError)) {
        throw error as Error;
      }
    }
    return uris.length > 0 ? uris[0] : null;
  }

  private stopTask(): void {
    const task: request.agent.Task | null = this.task;
    this.task = null;
    if (task === null) {
      return;
    }
    // remove() stops the task and clears it from the request agent.
    request.agent.remove(task.tid).catch((error: BusinessError) => {
      console.info(`baton download cleanup: ${error.code}`);
    });
  }

  private report(id: number, percent: number): void {
    if (percent === this.percent) {
      return;
    }
    this.percent = percent;
    this.channel?.progress(id, percent / 100);
  }

  private fail(id: number, message: string): void {
    this.channel?.reject(id, message);
  }
}
