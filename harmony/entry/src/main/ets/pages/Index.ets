import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { resourceManager } from '@kit.LocalizationKit';
import { NativeBridge } from '../bridge/NativeBridge';

// The web frontend is bundled under resources/rawfile (run sync-web). It is a
// vite build whose scripts are ES modules, which do NOT execute when loaded
// from a bare resource:// origin. So we serve rawfile over a custom standard
// scheme (app://) with correct MIME + CORS, registered in EntryAbility, giving
// the page a real web origin. Server URL + API key still arrive via a scanned
// / pasted Start URL — nothing is hardcoded.
const ENTRY: string = 'app://local/landing.html';

function mimeFor(path: string): string {
  const i: number = path.lastIndexOf('.');
  const ext: string = i >= 0 ? path.substring(i + 1).toLowerCase() : '';
  switch (ext) {
    case 'html':
    case 'htm': return 'text/html';
    case 'js':
    case 'mjs': return 'application/javascript';
    case 'css': return 'text/css';
    case 'json':
    case 'map': return 'application/json';
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'ico': return 'image/x-icon';
    case 'woff2': return 'font/woff2';
    case 'woff': return 'font/woff';
    case 'ttf': return 'font/ttf';
    case 'wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/')
    || mime === 'application/javascript'
    || mime === 'application/json'
    || mime === 'image/svg+xml';
}

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private nativeBridge: NativeBridge = new NativeBridge();
  private schemeHandler: webview.WebSchemeHandler = new webview.WebSchemeHandler();
  private resMgr: resourceManager.ResourceManager | null = null;
  @State loading: boolean = true;
  @State failed: boolean = false;

  aboutToAppear(): void {
    const ctx: common.Context = getContext(this);
    this.nativeBridge.attach(this.controller, ctx);
    this.resMgr = ctx.resourceManager;

    // Serve app://local/<path> from resources/rawfile with correct MIME + CORS.
    this.schemeHandler.onRequestStart(
      (request: webview.WebSchemeHandlerRequest, resourceHandler: webview.WebResourceHandler): boolean => {
        let path: string = request.getRequestUrl().replace(/^app:\/\/[^/]*\//, '');
        const q: number = path.indexOf('?');
        if (q >= 0) { path = path.substring(0, q); }
        const h: number = path.indexOf('#');
        if (h >= 0) { path = path.substring(0, h); }
        if (path.length === 0) { path = 'landing.html'; }
        path = decodeURIComponent(path);

        const resp: webview.WebSchemeHandlerResponse = new webview.WebSchemeHandlerResponse();
        resp.setHeaderByName('Access-Control-Allow-Origin', '*', false);
        try {
          const data: Uint8Array = this.resMgr!.getRawFileContentSync(path);
          const mime: string = mimeFor(path);
          resp.setStatus(200);
          resp.setStatusText('OK');
          resp.setMimeType(mime);
          if (isTextMime(mime)) { resp.setEncoding('utf-8'); }
          resourceHandler.didReceiveResponse(resp);
          resourceHandler.didReceiveResponseBody(data.buffer as ArrayBuffer);
          resourceHandler.didFinish();
        } catch (e) {
          resp.setStatus(404);
          resp.setStatusText('Not Found');
          resp.setMimeType('text/plain');
          resourceHandler.didReceiveResponse(resp);
          resourceHandler.didFinish();
        }
        return true;
      }
    );
  }

  // Stops an in-flight download and releases the preview loopback listeners;
  // otherwise those ports stay bound after the page is gone. The declarative
  // javaScriptProxy object is owned by the Web component, so it needs no
  // deleteJavaScriptRegister (that pairing only applies to the register* form).
  aboutToDisappear(): void {
    this.nativeBridge.release();
  }

  // Back key: navigate web history first, exit the app only at the first page.
  onBackPress(): boolean {
    if (this.controller.accessBackward()) {
      this.controller.backward();
      return true;
    }
    return false;
  }

  build() {
    Stack() {
      Web({ src: ENTRY, controller: this.controller })
        .onControllerAttached(() => {
          // Remote DevTools is enabled in EntryAbility.onCreate (before kernel init).
          // Must be registered before the first app:// request is served.
          this.controller.setWebSchemeHandler('app', this.schemeHandler);
        })
        .domStorageAccess(true)     // localStorage: _ak/_as auth + nav cache
        .javaScriptAccess(true)
        .databaseAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .onlineImageAccess(true)
        // Remote preview loads http://127.0.0.1:<port> in an iframe, and app://
        // is registered as a secure origin, so that frame is mixed content and
        // MixedMode.None would block it. The document itself only ever loads
        // app:// rawfile assets and the HTTPS API, so this only affects previews.
        .mixedMode(MixedMode.All)
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
        // Every native capability goes through this one object: the declarative
        // javaScriptProxy is the injection form verified to reach the first page
        // load, while registerJavaScriptProxy objects are documented to appear
        // only after the next (re)load. It takes a single name, so
        // web/js/harmony-bridge.js expands window.harmonyBridge back into the
        // per-feature namespaces the frontend feature-detects.
        .javaScriptProxy({
          object: this.nativeBridge,
          name: 'harmonyBridge',
          methodList: NativeBridge.METHODS,
          controller: this.controller
        })
        .width('100%')
        .height('100%')
        .onPageBegin(() => { this.loading = true; this.failed = false; })
        .onPageEnd(() => { this.loading = false; })
        .onErrorReceive((e) => {
          if (e && e.request && e.request.isMainFrame()) {
            this.loading = false;
            this.failed = true;
          }
        })

      if (this.loading && !this.failed) {
        LoadingProgress().width(48).height(48)
      }

      if (this.failed) {
        Column({ space: 12 }) {
          Text($r('app.string.load_failed'))
          Button($r('app.string.retry')).onClick(() => {
            this.failed = false;
            this.loading = true;
            this.controller.loadUrl(ENTRY);
          })
        }
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0D1117')
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }
}
