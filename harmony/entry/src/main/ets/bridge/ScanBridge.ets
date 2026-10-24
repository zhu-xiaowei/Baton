import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';

// Reached from the webview as window.harmonyScanBridge.scan() (see NativeBridge).
// The frontend (web/js/entry-landing.js) calls scan(); the ScanKit default UI
// handles the camera, permission prompt and cancel, then we hand the decoded
// string back via window.__onHarmonyScan / window.__onHarmonyScanError.
export class ScanBridge {
  controller: webview.WebviewController | null = null;
  context: common.Context | null = null;

  scan(): void {
    if (!this.controller || !this.context) {
      return;
    }
    const options: scanBarcode.ScanOptions = {
      scanTypes: [scanCore.ScanType.QR_CODE],
      enableMultiMode: false,
      enableAlbum: true
    };
    scanBarcode.startScanForResult(this.context, options)
      .then((result: scanBarcode.ScanResult) => {
        const value: string = JSON.stringify(result.originalValue ?? '');
        this.controller?.runJavaScript(
          `window.__onHarmonyScan && window.__onHarmonyScan(${value})`
        );
      })
      .catch((err: BusinessError) => {
        const code: string = JSON.stringify(String(err?.code ?? ''));
        this.controller?.runJavaScript(
          `window.__onHarmonyScanError && window.__onHarmonyScanError(${code})`
        );
      });
  }

  release(): void {
    this.controller = null;
  }
}
