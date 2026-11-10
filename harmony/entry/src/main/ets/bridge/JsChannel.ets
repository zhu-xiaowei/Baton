import { webview } from '@kit.ArkWeb';

// The only way native code answers the page: window.__onHarmony(message) with
// {id, result} | {id, error} | {id, progress} for a call, or {event, ...} pushed.
export class JsChannel {
  controller: webview.WebviewController | null = null;

  resolve(id: number, resultJson: string): void {
    this.post(`{"id":${id},"result":${resultJson}}`);
  }

  reject(id: number, message: string): void {
    this.post(`{"id":${id},"error":${JSON.stringify(message)}}`);
  }

  progress(id: number, fraction: number): void {
    this.post(`{"id":${id},"progress":${fraction}}`);
  }

  event(json: string): void {
    this.post(json);
  }

  private post(json: string): void {
    // runJavaScript evaluates source; escape U+2028/U+2029 so they cannot end the expression.
    const safe: string = json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    try {
      this.controller?.runJavaScript(`window.__onHarmony && window.__onHarmony(${safe})`);
    } catch (e) {
      // The page navigated away; nothing is waiting for this message.
    }
  }
}
