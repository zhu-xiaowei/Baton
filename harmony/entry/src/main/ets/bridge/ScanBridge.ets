import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { JsChannel } from './JsChannel';

class ScanArgs {
  id: number = 0;
}

// ScanKit's default UI owns the camera, permission prompt and cancel.
export class ScanBridge {
  channel: JsChannel | null = null;
  context: common.Context | null = null;

  scan(argsJson: string): void {
    let args: ScanArgs;
    try {
      args = JSON.parse(argsJson) as ScanArgs;
    } catch (e) {
      return;
    }
    const id: number = args.id;
    const context: common.Context | null = this.context;
    if (context === null) {
      this.channel?.reject(id, 'Scanning is unavailable');
      return;
    }
    const options: scanBarcode.ScanOptions = {
      scanTypes: [scanCore.ScanType.QR_CODE],
      enableMultiMode: false,
      enableAlbum: true
    };
    scanBarcode.startScanForResult(context, options)
      .then((result: scanBarcode.ScanResult) => {
        this.channel?.resolve(id, JSON.stringify(result.originalValue ?? ''));
      })
      .catch((error: BusinessError) => {
        this.channel?.reject(id, `${error?.code ?? ''}`);
      });
  }
}
