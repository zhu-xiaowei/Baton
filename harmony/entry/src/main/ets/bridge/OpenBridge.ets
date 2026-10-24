import { common, Want } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';

// Injected into the webview as window.harmonyOpenBridge. ArkWeb cannot open a
// new tab for target=_blank, so external links (and Remote preview's "Open in
// browser") hand the URL to the system browser, the same role plugin-opener
// plays in the Tauri shells. http/https only — an app scheme from page content
// must not be able to start an arbitrary ability.

// A class, not an interface: ArkTS only casts parsed JSON onto a declared class.
class OpenArgs {
  id: number = 0;
  url: string = '';
}

interface OpenError {
  error: string;
}

export class OpenBridge {
  controller: webview.WebviewController | null = null;
  context: common.UIAbilityContext | null = null;

  open(argsJson: string): void {
    let args: OpenArgs | null = null;
    try {
      args = JSON.parse(argsJson) as OpenArgs;
    } catch (e) {
      return;
    }
    const url: string = `${args.url}`;
    const context: common.UIAbilityContext | null = this.context;
    if (context === null) {
      this.fail(args.id, 'Opening links is unavailable');
      return;
    }
    if (!/^https?:\/\/[^/?#]+/.test(url)) {
      this.fail(args.id, 'Only http and https links can be opened');
      return;
    }
    const id: number = args.id;
    const want: Want = {
      action: 'ohos.want.action.viewData',
      entities: ['entity.system.browsable'],
      uri: url
    };
    context.startAbility(want)
      .then(() => this.reply(id, '{}'))
      .catch((error: BusinessError) => this.fail(id, `${error.message}`));
  }

  release(): void {
    this.controller = null;
  }

  private fail(id: number, message: string): void {
    // runJavaScript evaluates this as source, and JSON.stringify leaves
    // U+2028/U+2029 raw — a syntax error there would drop the reply.
    const result: OpenError = { error: message.replace(/[\u2028\u2029]/g, ' ') };
    this.reply(id, JSON.stringify(result));
  }

  private reply(id: number, json: string): void {
    try {
      this.controller?.runJavaScript(`window.__onHarmonyOpen && window.__onHarmonyOpen(${id}, ${json})`);
    } catch (e) {
      // The page navigated away; nothing is waiting for this result.
    }
  }
}
