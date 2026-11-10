# Baton for HarmonyOS NEXT

[English](README.md) | **中文**

用 ArkWeb 包装的鸿蒙壳，前端与 Tauri 各端共用同一份 `web/`。App 内不写入服务器地址和
API key：扫描 setup 页的二维码，或粘贴 Start URL 即可登录。

目前还没有 AppGallery 版本，请自行构建并安装到自己的设备上。

## 构建与安装

准备：Node.js 20+、装好 HarmonyOS SDK 的 DevEco Studio、华为账号，以及一台
HarmonyOS NEXT 手机或平板。

1. 打包 Web 前端（每次前端更新后都要重新执行）：

   ```bash
   bash harmony/sync-web.sh                                       # macOS / Linux
   powershell -ExecutionPolicy Bypass -File harmony\sync-web.ps1  # Windows
   ```

2. 在 DevEco Studio 中打开 `harmony/` 目录。
3. File → Project Structure → Signing Configs → 勾选 **Automatically generate
   signature**，并登录华为账号。不要提交生成的签名配置
   （`git checkout harmony/build-profile.json5`）。
4. 在设备上打开开发者选项和 USB 调试，然后连接电脑。
5. 点击 **Run**。

如果自动签名提示包名不可用，可在本地把 `AppScope/app.json5` 中的 `bundleName`
改成任意唯一值后再构建。

## 与 Tauri 版的差异

- 页面从 `app://local/` 加载：这是注册为安全源的自定义 scheme，由 `rawfile/` 提供内容，
  保证 ES module 能正常执行。
- 扫码、下载/保存、Remote preview 和外链都通过注入的同一个 `window.harmonyBridge`
  （`entry/src/main/ets/bridge/NativeBridge.ets`）。
- 同一时间只能进行一个下载或保存，前一个完成前，再发起的会直接失败。
- Remote preview 不支持 TCP 半关闭，远端 FIN 会关闭整条连接；本地端口也可能与远程端口不同。
- 开启 `MixedMode.All`，是为了让 `app://` 页面能加载 `http://127.0.0.1` 的预览 iframe。
