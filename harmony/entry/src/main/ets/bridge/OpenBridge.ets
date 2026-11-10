import { common, Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { JsChannel } from './JsChannel';

class OpenArgs {
  id: number = 0;
  url: string = '';
}

// Hands http/https links to the system browser; page content must not start other abilities.
export class OpenBridge {
  channel: JsChannel | null = null;
  context: common.UIAbilityContext | null = null;

  open(argsJson: string): void {
    let args: OpenArgs;
    try {
      args = JSON.parse(argsJson) as OpenArgs;
    } catch (e) {
      return;
    }
    const id: number = args.id;
    const url: string = `${args.url}`;
    const context: common.UIAbilityContext | null = this.context;
    if (context === null) {
      this.channel?.reject(id, 'Opening links is unavailable');
      return;
    }
    if (!/^https?:\/\/[^/?#]+/.test(url)) {
      this.channel?.reject(id, 'Only http and https links can be opened');
      return;
    }
    const want: Want = {
      action: 'ohos.want.action.viewData',
      entities: ['entity.system.browsable'],
      uri: url
    };
    context.startAbility(want)
      .then(() => this.channel?.resolve(id, 'null'))
      .catch((error: BusinessError) => this.channel?.reject(id, `${error.message}`));
  }
}
