import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { DownloadBridge } from './DownloadBridge';
import { OpenBridge } from './OpenBridge';
import { PreviewBridge } from './PreviewBridge';
import { ScanBridge } from './ScanBridge';

// One facade, injected as window.harmonyBridge through the declarative
// javaScriptProxy attribute — the injection form verified to reach the first page
// load. registerJavaScriptProxy is avoided because it documents that "注入的对象在
// 页面下一次（重新）加载前不会出现在 JavaScript 中", and a bridge that fails to
// inject fails silently.
//
// javaScriptProxy takes a single object and name, so every bridge is reached
// through this one. web/js/harmony-bridge.js expands it back into the
// per-feature namespaces the frontend feature-detects
// (harmonyScanBridge / harmonyDownloadBridge / harmonyPreviewBridge /
// harmonyOpenBridge), so no other frontend module knows about the facade.
export class NativeBridge {
  readonly scanner: ScanBridge = new ScanBridge();
  readonly downloads: DownloadBridge = new DownloadBridge();
  readonly preview: PreviewBridge = new PreviewBridge();
  readonly links: OpenBridge = new OpenBridge();

  // Every method listed in methodList must exist here; the frontend contract is
  // the JSON payload of each one, documented with the bridge that implements it.
  static readonly METHODS: string[] = [
    'scan', 'download', 'openExternal', 'previewStart', 'previewStop',
    'previewReset', 'previewWrite', 'previewShutdownWrite', 'previewCredit',
    'previewCloseSocket'
  ];

  attach(controller: webview.WebviewController, context: common.Context): void {
    this.scanner.controller = controller;
    this.scanner.context = context;
    this.downloads.controller = controller;
    this.downloads.context = context;
    this.preview.controller = controller;
    this.links.controller = controller;
    this.links.context = context as common.UIAbilityContext;
  }

  release(): void {
    this.scanner.release();
    this.downloads.release();
    this.preview.release();
    this.links.release();
  }

  scan(): void {
    this.scanner.scan();
  }

  download(argsJson: string): void {
    this.downloads.download(argsJson);
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
