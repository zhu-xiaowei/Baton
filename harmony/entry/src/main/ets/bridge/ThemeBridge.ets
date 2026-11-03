import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { window } from '@kit.ArkUI';

// Same contract as BatonAndroid.setTheme/getTheme: the page reports its resolved
// appearance; the shell paints system bars and backgrounds to match and keeps
// the choice so the next cold start opens in it.

export class Appearance {
  mode: string = 'dark';
  preference: string = 'dark';
  canvas: string = '#0D1117';
}

const STORE: string = 'appearance';
// Index.ets binds @StorageProp('baton.canvas') to this key.
export const CANVAS_KEY: string = 'baton.canvas';

function colorMode(preference: string): ConfigurationConstant.ColorMode {
  if (preference === 'light') {
    return ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
  }
  if (preference === 'dark') {
    return ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }
  return ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
}

export class ThemeBridge {
  static mainWindow: window.Window | null = null;
  context: common.Context | null = null;

  static load(context: common.Context): Appearance {
    const saved: Appearance = new Appearance();
    try {
      const store: preferences.Preferences = preferences.getPreferencesSync(context, { name: STORE });
      saved.mode = store.getSync('mode', saved.mode) as string;
      saved.preference = store.getSync('preference', saved.preference) as string;
      saved.canvas = store.getSync('canvas', saved.canvas) as string;
    } catch (e) {
      // First launch, or unreadable: keep the dark default.
    }
    return saved;
  }

  // Also drives the start window (resources/dark) and system dialogs.
  static applyColorMode(context: common.Context, preference: string): void {
    try {
      context.getApplicationContext().setColorMode(colorMode(preference));
    } catch (e) {
      console.error(`setColorMode failed: ${JSON.stringify(e)}`);
    }
  }

  static paint(mode: string, canvas: string): void {
    AppStorage.setOrCreate(CANVAS_KEY, canvas);
    const win: window.Window | null = ThemeBridge.mainWindow;
    if (win === null) {
      return;
    }
    const content: string = mode === 'light' ? '#000000' : '#FFFFFF';
    try {
      win.setWindowSystemBarProperties({
        statusBarColor: '#00000000',
        statusBarContentColor: content,
        navigationBarColor: '#00000000',
        navigationBarContentColor: content
      });
      win.setWindowBackgroundColor(canvas);
    } catch (e) {
      console.error(`theme paint failed: ${JSON.stringify(e)}`);
    }
  }

  get(): string {
    return this.context === null ? '' : ThemeBridge.load(this.context).preference;
  }

  set(argsJson: string): void {
    let next: Appearance;
    try {
      next = JSON.parse(argsJson) as Appearance;
    } catch (e) {
      return;
    }
    const mode: string = `${next.mode}`;
    const preference: string = `${next.preference}`;
    const canvas: string = `${next.canvas}`;
    if ((mode !== 'light' && mode !== 'dark') || !['system', 'light', 'dark'].includes(preference)
      || !/^#[0-9a-fA-F]{6}$/.test(canvas)) {
      return;
    }
    const context: common.Context | null = this.context;
    if (context !== null) {
      try {
        const store: preferences.Preferences = preferences.getPreferencesSync(context, { name: STORE });
        store.putSync('mode', mode);
        store.putSync('preference', preference);
        store.putSync('canvas', canvas);
        store.flush();
      } catch (e) {
        console.error(`theme save failed: ${JSON.stringify(e)}`);
      }
      ThemeBridge.applyColorMode(context, preference);
    }
    ThemeBridge.paint(mode, canvas);
  }
}
