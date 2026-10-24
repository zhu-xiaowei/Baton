import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    // Remote DevTools (PC chrome://inspect over hdc). Must be set BEFORE the
    // ArkWeb kernel initializes, so it lives here rather than onControllerAttached
    // (where the kernel is already up and the switch no-ops). Disable for release.
    try {
      webview.WebviewController.setWebDebuggingAccess(true);
    } catch (e) {
      console.error(`setWebDebuggingAccess failed: ${JSON.stringify(e)}`);
    }

    // Register the app:// scheme BEFORE any Web component initializes the kernel.
    // Standard + CORS + fetch + secure → a real web origin so ES module scripts
    // execute and cross-origin fetch to the HTTPS API is allowed.
    try {
      webview.WebviewController.customizeSchemes([
        {
          schemeName: 'app',
          isStandard: true,
          isSupportCORS: true,
          isSupportFetch: true,
          isSecure: true
        }
      ]);
    } catch (e) {
      console.error(`customizeSchemes failed: ${JSON.stringify(e)}`);
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        console.error(`loadContent failed: ${JSON.stringify(err)}`);
      }
    });
    // Paint the status/navigation bars in the brand dark so they don't show as
    // white strips above/below the dark web content; use light bar icons.
    try {
      const win = windowStage.getMainWindowSync();
      // Edge-to-edge: let the web (expandSafeArea) draw under the gesture inset
      // so no white strip remains; the web pads itself via env(safe-area-inset-*).
      win.setWindowLayoutFullScreen(true);
      win.setWindowSystemBarProperties({
        statusBarColor: '#00000000',
        statusBarContentColor: '#FFFFFF',
        navigationBarColor: '#00000000',
        navigationBarContentColor: '#FFFFFF'
      });
      // Dark base so any area not painted by the web is dark, never white.
      win.setWindowBackgroundColor('#0D1117');
    } catch (e) {
      console.error(`window chrome setup failed: ${JSON.stringify(e)}`);
    }
  }
}
