import { bundleManager, common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { DownloadBridge } from './DownloadBridge';
import { JsChannel } from './JsChannel';
import { OpenBridge } from './OpenBridge';
import { PreviewBridge } from './PreviewBridge';
import { ScanBridge } from './ScanBridge';
import { ThemeBridge } from './ThemeBridge';

class AppVersion {
  versionName: string = '';
  versionCode: number = 0;
}

// Injected as window.harmonyBridge. Every method takes one JSON argument (getters
// appVersion and getTheme take none and return synchronously); calls
// with an id are answered through JsChannel (web/js/harmony.js on the page side).
export class NativeBridge {
  readonly channel: JsChannel = new JsChannel();
  readonly scanner: ScanBridge = new ScanBridge();
  readonly downloads: DownloadBridge = new DownloadBridge();
  readonly preview: PreviewBridge = new PreviewBridge();
  readonly links: OpenBridge = new OpenBridge();
  readonly theme: ThemeBridge = new ThemeBridge();

  static readonly METHODS: string[] = [
    'scan', 'download', 'save', 'openExternal', 'previewStart', 'previewStop',
    'previewReset', 'previewWrite', 'previewShutdownWrite', 'previewCredit',
    'previewCloseSocket', 'cancelDownload', 'appVersion', 'getTheme', 'setTheme'
  ];

  attach(controller: webview.WebviewController, context: common.Context): void {
    this.channel.controller = controller;
    this.scanner.channel = this.channel;
    this.scanner.context = context;
    this.downloads.channel = this.channel;
    this.downloads.context = context;
    this.preview.channel = this.channel;
    this.links.channel = this.channel;
    this.links.context = context as common.UIAbilityContext;
    this.theme.context = context;
  }

  release(): void {
    this.channel.controller = null;
    this.downloads.release();
    this.preview.release();
  }

  scan(argsJson: string): void {
    this.scanner.scan(argsJson);
  }

  download(argsJson: string): void {
    this.downloads.download(argsJson);
  }

  save(argsJson: string): void {
    this.downloads.save(argsJson);
  }

  cancelDownload(_argsJson: string): void {
    this.downloads.cancel();
  }

  // Synchronous: returns {versionName, versionCode} as JSON.
  appVersion(): string {
    const version: AppVersion = new AppVersion();
    try {
      const info: bundleManager.BundleInfo =
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      version.versionName = info.versionName;
      version.versionCode = info.versionCode;
    } catch (e) {
      // Leave it empty; the page keeps its built-in version.
    }
    return JSON.stringify(version);
  }

  // Synchronous: read by web/public/theme-init.js before first paint.
  getTheme(): string {
    return this.theme.get();
  }

  setTheme(argsJson: string): void {
    this.theme.set(argsJson);
  }

  openExternal(argsJson: string): void {
    this.links.open(argsJson);
  }

  previewStart(argsJson: string): void {
    this.preview.start(argsJson);
  }

  previewStop(argsJson: string): void {
    this.preview.stop(argsJson);
  }

  previewReset(argsJson: string): void {
    this.preview.reset(argsJson);
  }

  previewWrite(argsJson: string): void {
    this.preview.write(argsJson);
  }

  previewShutdownWrite(argsJson: string): void {
    this.preview.shutdownWrite(argsJson);
  }

  previewCredit(argsJson: string): void {
    this.preview.credit(argsJson);
  }

  previewCloseSocket(argsJson: string): void {
    this.preview.closeSocket(argsJson);
  }
}
