# Baton — HarmonyOS NEXT 壳

把 Baton 的 Web 前端用 ArkWeb (`Web` 组件) 包成纯血鸿蒙 (HarmonyOS NEXT) 应用。
与 `src-tauri/`（Android/iOS/桌面壳）平级，职责完全相同：**只做壳，不含业务逻辑，
服务器地址和 API key 都不写进 App**。

## 架构（对齐现有 Tauri App）

现有原生 App 的做法（见 `web/js/entry-landing.js`）：

1. **前端本地打包进 App**：Tauri 把 `npm run build` 的 `dist/` 作为 `frontendDist`
   打进包里，webview 加载**本地** `landing.html`（origin 非 http），不连某个固定远程地址。
2. **服务器 URL + key 靠「Start URL」带进来**，App 里零硬编码。Start URL 两种形态：
   - `https://<server>/?t=<一次性token>`（install.sh 下发，60 分钟单次有效）
   - `https://<server>/?key=<apiKey>`（setup 页二维码，永久）
3. 获取方式：**扫码**（setup 页的二维码，内容即上面的 Start URL）或**手动粘贴**到登录框。
4. landing 页解析出 server(origin) 和 token/key，token 再 `POST /auth/exchange-token`
   换 apiKey，最后把 **key 存 `_ak`、server URL 存 `_as`**（localStorage）。

鸿蒙壳 100% 照搬这套：本地打包 `rawfile/`，登录靠扫码/粘贴 Start URL。

### 为什么用 `app://` 自定义 scheme 而不是 `$rawfile`

vite 构建产物的脚本是 **ES module**，从裸 `resource://`/`$rawfile` 本地源加载时**不会执行**
（Chromium 对 module 的 MIME/源要求严格，classic 脚本不受影响）→ 表现为页面能显示但
`entry-landing.js` 不运行（按钮无反应、扫码按钮不出现）。

解法：`EntryAbility.onCreate` 用 `webview.WebviewController.customizeSchemes` 注册一个
**标准 + CORS + fetch + secure** 的 `app://` scheme；`Index.ets` 用 `WebSchemeHandler`
从 `rawfile` 读文件、按扩展名返回正确 MIME + `Access-Control-Allow-Origin: *`；页面从
`app://local/landing.html` 加载。这样页面有正常 web 源 → module 正常执行、且能跨域 fetch
远程 HTTPS API。前端 `isNativeApp`（`!origin.startsWith('http')`）对 `app://` 仍为 true，
走原生登录分支（存 `_as`）。

调试：`onControllerAttached` 里 `setWebDebuggingAccess(true)` 已开，真机用 PC Chrome
`chrome://inspect`（经 hdc）看 console。**发布前应关掉**。

> 跨域不是问题：API Gateway 对所有接口返回 `Access-Control-Allow-Origin: *` 且允许
> `x-api-key` 头，鉴权走 header 不走 cookie，所以本地页面(resource origin) 调远程 API 放行。

## 打包前端进 App

```
# macOS / Linux
bash harmony/sync-web.sh
# Windows PowerShell
powershell -ExecutionPolicy Bypass -File harmony\sync-web.ps1
```

脚本做：仓库根 `npm run build` → 清空 `entry/src/main/resources/rawfile/`（保留 `.gitkeep`）
→ 把 `dist/` 全部拷进去。入口页 `rawfile/landing.html`。`rawfile/` 内容已 gitignore。
每次前端更新都要重跑此脚本再出鸿蒙包。需本机已装 Node + npm。

## 在 DevEco Studio 里打开/构建

> ⚠️ **本机是 Linux，无法编译/模拟鸿蒙**。需要装了 DevEco Studio 的 Windows / macOS
> 机器 + HarmonyOS SDK（鸿蒙无跨平台命令行云构建）。

**推荐做法（最稳，避开 SDK 版本 schema 差异）：**

1. DevEco Studio → 新建 **Empty Ability**（ArkTS, Stage 模型, HarmonyOS NEXT）工程。
   这会生成与本地 SDK 匹配的 `build-profile.json5` / `hvigorfile.ts` / `oh-package.json5` /
   app 图标 (`AppScope/resources/.../media`) / 签名配置。
2. 把本目录的**壳源码**合并进去（这些才是有价值的部分）：
   - `entry/src/main/ets/pages/Index.ets`（★ Web 壳，`src = $rawfile('landing.html')`）
   - `entry/src/main/ets/entryability/EntryAbility.ets`
   - `entry/src/main/module.json5` 的 `requestPermissions`（`ohos.permission.INTERNET`）
   - `string.json` / `color.json` 新增条目
3. `bash harmony/sync-web.sh` 把前端打进 `rawfile/`。
4. 构建版本已对齐本机真实可 build 的项目（`/home/ec2-user/data/paging/src/app`）：
   `targetSdkVersion 26.0.0` / `compatibleSdkVersion 6.1.1(24)` / `modelVersion 26.0.0`。
   以你 DevEco 实装 SDK 为准，不符按提示微调。签名 (`signingConfigs`) 已留空——
   由 DevEco 自动签名或填你自己的证书，**切勿把证书/密码提交进仓库**（DevEco 自动签名会
   把证书路径+密码写进 `build-profile.json5`，提交前用 `git checkout harmony/build-profile.json5` 还原）。
   App 图标已内置（品牌徽标 `foreground.png` + 深色底 `background.png` + `layered_image.json`，
   启动图标 `startIcon.png`），无需从模板拷。
5. Run 到真机；Release 用 DevEco 应用签名出 `.hap/.app`，经 AppGallery Connect 上架。

## 登录（粘贴 / 扫码，均已实现）

- **粘贴**：打开 App → landing 页 → 在 Baton setup 页（桌面/网页端 `setup.html`）复制那条
  `https://<server>/?key=...` Start URL → 粘进登录框 → Connect。
- **扫码**：landing 页的扫码按钮经原生 ScanKit 桥完成（见下），直接扫 setup 页的二维码。

### 原生桥只能有一个：`window.harmonyBridge` 门面

官方文档对 `registerJavaScriptProxy` 写了一条硬约束：「注入的对象在页面下一次（重新）加载前
不会出现在 JavaScript 中」。在 `onControllerAttached`（首次 `loadUrl` 之前）注册是否算
「下一次加载」没有明确答案，也没有在真机上验证过；而**声明式 `.javaScriptProxy()` 属性
是已验证可用的那一个**（扫码桥一直走它）。桥没注入的失败是静默的——下载只显示
"Download started."、Remote preview 按钮全灰——所以这里不赌，统一走声明式。

声明式属性只接受一个对象 + 一个名字，
于是 `entry/src/main/ets/bridge/NativeBridge.ets` 是唯一注入对象（`window.harmonyBridge`），
把方法转发给 `ScanBridge` / `DownloadBridge` / `PreviewBridge` / `OpenBridge`；
`NativeBridge.METHODS` 是 `methodList` 的唯一来源。前端 `web/js/harmony-bridge.js`
再把它展开回 `window.harmonyScanBridge` / `harmonyDownloadBridge` / `harmonyPreviewBridge` /
`harmonyOpenBridge` 四个命名空间——它是 `entry-index.js` / `entry-landing.js` 的**第一个
import**，必须早于任何 feature-detect；因此其余前端模块完全不知道门面的存在，
`download.js`、`preview-native.js`、`entry-landing.js` 的检测代码一行都不用改。

两侧方法名漂移由 `test/frontend/harmony-preview.test.mjs` 的
「facade method list matches what the frontend expands」挡住。
声明式注入的对象由 Web 组件管生命周期，**不需要** `deleteJavaScriptRegister`
（那是 `register*` 形式才要配对的）；要释放的是桥自己的资源，走 `NativeBridge.release()`。

### 扫码实现（ScanKit 桥）

- `entry/src/main/ets/bridge/ScanBridge.ets` 经门面暴露为 `window.harmonyScanBridge`，
  调 `@kit.ScanKit` 的 `scanBarcode.startScanForResult`（系统自带全屏扫码 UI，含相机权限引导、
  相册、取消），扫到后用 `runJavaScript` 回调 `window.__onHarmonyScan(内容)`。
- 前端 `web/js/entry-landing.js` 检测到 `window.harmonyScanBridge` 时走鸿蒙分支，把扫到的
  Start URL 交给与粘贴/Tauri 相同的 `applyStartUrl` 登录流程。该分支纯增量，桥不存在
  （Tauri/浏览器/桌面）时行为零变化。
- 需要 `ohos.permission.CAMERA`（已在 `module.json5` 声明，首次扫码由 ScanKit UI 引导授权）。

### 文件下载实现（DownloadBridge 桥）

ArkWeb 不处理 `<a download>`（点击被直接丢弃，前端只会显示 "Download started." 而拿不到文件），
所以下载必须走原生。`entry/src/main/ets/bridge/DownloadBridge.ets` 经上面的门面暴露为
`window.harmonyDownloadBridge`，前端
`web/js/project/download.js` 的 `nativeDownloads()` 认到它就把下载交给原生（于是
`browserCanShare()` 自动为 false，不会再去试 `navigator.share`）。

流程与 `src-tauri/plugins/tauri-plugin-file-download` 的约束完全一致——仅 https、拒绝
URL 内嵌用户名密码、文件名净化、512 MB 上限、同一时刻只允许一个下载——差别只在**文件落在哪**：

1. `request.agent`（`Action.DOWNLOAD` + `Mode.FOREGROUND`）流式下到应用缓存
   `cacheDir/baton-download/`，大文件不吃内存；`progress` 事件回调
   `window.__onHarmonyDownloadProgress`，文件查看器状态行显示 `Downloading… 42%`。
2. 完成后 `picker.DocumentViewPicker().save()` 弹系统保存框（默认定位「下载」目录、文件名已填好），
   用户选定后 `fs.openSync(uri)` + `fs.copyFile` 写入 → 回 `{status:'saved_as'}` → 显示 `Saved.`；
   取消保存回 `{status:'cancelled'}`（状态行清空）。
3. 无论成功、失败、取消，`finally` 里一定 `request.agent.remove` + 删掉缓存副本。

为什么不直接写系统「下载」目录：鸿蒙 NEXT 沙箱下这需要受限 ACL 权限
（`READ_WRITE_DOWNLOAD_DIRECTORY`），普通应用拿不到；保存框是官方路径，且**不需要任何新权限**。

两个工程上的坑已处理：
- `gauge` 只对后台任务生效，前台任务没有系统通知进度条 → 应用内百分比是唯一进度来源。
- 前台任务在应用长时间退到后台后可能被**暂停**，暂停既不触发 `completed` 也不触发 `failed`
  → 加了 60 秒停滞看门狗（每次 progress 重置），否则前端按钮会永久转圈。

回归测试：`test/frontend/harmony-download.test.mjs`（`npm run test:frontend`）覆盖前端桥接
（payload、进度、按 id 路由、错误/取消、与 `browserCanShare` 的互斥）以及 ArkTS 侧的上述不变量。

### Remote preview 实现（PreviewBridge + OpenBridge 桥）

Remote preview 由三段组成，只有第三段是平台相关的：隧道协议（`bridge/preview-protocol.mjs`
+ 服务端 `preview_data` 路由）是纯 JS，隧道编排（`web/js/preview-transport.js`）平台无关，
**本地 loopback 代理**在 Tauri 是 `src-tauri/src/preview_proxy.rs`（Rust TCP listener），
鸿蒙则是 `entry/src/main/ets/bridge/PreviewBridge.ets`。

前端用 `web/js/preview-native.js` 吃掉这层差异：它对外仍是 Tauri 的命令名
（`preview_start/stop/reset/write/shutdown_write/credit/close_socket`）和事件名
（`preview-socket-open/bytes/fin/close`），内部分 Tauri `invoke/listen` 与
`window.harmonyPreviewBridge`（即门面展开出来的那层）两支，所以 `preview-transport.js`
一行业务逻辑都没改。
`previewNativeAvailable()` 同时是「有没有 Remote preview」的唯一判定（preview 面板按钮、
会话里 loopback 链接的拦截与预热都用它）。

ArkTS 侧用 `@kit.NetworkKit` 的 `socket.TCPSocketServer` 在 `127.0.0.1` 上监听，
把 webview iframe 的连接切成 16 KB 分片推给 JS，再把隧道回来的字节写回 socket。
限额与 Tauri 完全一致：16 KB 分片 / 128 KB 单流窗口 / 24 流一隧道 / 4 隧道 / 浏览器方向
积压上限 512 KB。三个鸿蒙特有的点：

1. **真实端口必须回读**。文档明确写 `listen()` 在 bind 失败时**不会报错，而是由系统随机
   分配端口**，所以绑定成功后一律用 `getLocalAddress()` 取实际端口再拼 origin；真抛错
   （如 `2303198 Address already in use`）才递增换端口重试（上限 16 次）。
2. **credit 流控落在应用层队列上**。`on('message')` 是推送式，没有办法像 Rust 那样靠
   「读到配额为止」回压，所以分片先入队、按 credit 投递；队列超 512 KB 直接断掉该流。
3. **没有半关闭**。`TCPSocketConnection` 不提供 `shutdown(Write)`，所以远端 FIN
   （`preview_shutdown_write`）实现为「把已排队的 send 写完后 close 整条连接」。浏览器
   仍能看到结束响应所需的 FIN，代价是这条连接不能再被 keep-alive 复用，会新建一条。

`.mixedMode(MixedMode.All)`：页面是 `app://`（注册为 secure 源），预览 iframe 是
`http://127.0.0.1:<port>`，属于 mixed content，`MixedMode.None` 会直接拦掉。主文档只加载
`app://` rawfile 和 HTTPS API，放开实际只影响预览 iframe。

`OpenBridge`（`window.harmonyOpenBridge`）补上 Tauri 的 plugin-opener：ArkWeb 同样开不了
新标签页，所以 preview 的「Open in browser」和消息里的普通外链都经
`startAbility({action:'ohos.want.action.viewData'})` 交给系统浏览器，只放行 http/https。

回归测试：`test/frontend/harmony-preview.test.mjs`（`npm run test:frontend`）覆盖前端适配层
（命令映射与 payload、按 id 配对的回复与错误、事件分发/注销、`previewNativeAvailable`、
外链桥）以及 ArkTS 侧上述不变量。

### 鸿蒙壳也算「原生移动端」（native-mobile）

前端用 `window.__BATON_NATIVE_MOBILE__` + `html.native-mobile` 区分「原生手机 App」与
「浏览器」，原先的判定是 `!!window.__TAURI_INTERNALS__ && 移动端 UA`——鸿蒙壳没有 Tauri
internals，于是恒为 false，一整类移动端能力在鸿蒙下**静默缺失**：终端的底部按键条
（Esc/Tab/Ctrl/Shift/Alt/Paste/Enter，CSS 门槛是 `html.native-mobile .keyboard-open`）、
终端长按出来的方向摇杆（`terminal.js` 只在该 flag 为真时挂 `attachTerminalKeybar`）、
软键盘弹出时的自动贴底、边缘滑动返回手势，以及移动端字号 / 44px 点击区那一大片样式。

`web/public/native-mobile.js` 现在把鸿蒙壳也判为 native mobile，三条判据任一命中即可：

1. **`app://` 源**——这个 scheme 是本壳在 `EntryAbility` 里自己注册的，别的平台都不用
   （Tauri 是 `tauri://`），所以它在每个页面都成立，包括不装门面的 `setup.html`；
2. UA 命中 `OpenHarmony|HarmonyOS|ArkWeb` **且**源不是 http(s)（挡掉鸿蒙系统浏览器访问线上站点）；
3. `window.harmonyBridge` 已注入。

因为声明式 `javaScriptProxy` 是否早于 head 内联脚本注入没有真机结论，检测体以
`window.__batonSyncNativeMobile` 暴露，`web/js/harmony-bridge.js` 展开门面后会再算一次
（它是入口模块的第一个 import，早于任何 UI）。回归测试在
`test/frontend/native-mobile.test.mjs`。

两处 Tauri 专属行为**暂未**为鸿蒙做例外，需真机确认是否要加：

1. `edge-back.js` 的页内边缘返回触发区是左边缘 24px，正是鸿蒙系统返回手势区——系统吞掉
   手势则页内手势永不触发（无害），若两者都生效则会一次退两层。鸿蒙的返回本来就由
   `Index.ets` 的 `onBackPress → controller.backward()` 走 web history。
2. `style.css` 横屏下 `html.native-mobile` 会隐藏 top-bar 与 breadcrumb，那套规则依赖 iOS
   `main.mm` 注入的 `--sat/--sal/--sar`，并假定横屏靠边缘手势导航；鸿蒙两者都没有，若横屏
   顶栏消失又没有返回手势，就没有任何返回入口。真要例外，给 html 多加一个
   `harmony-shell` class，用 `html.native-mobile:not(.harmony-shell)` 收窄即可。

## 兼容性检查表（跑起来后逐项验证）

- [ ] **本地页加载**：`$rawfile('landing.html')` 能渲染，相对资源(js/css)不 404
      （vite `base: './'` 已出相对路径）。
- [ ] **isNativeApp 判定**：确认 `$rawfile` 的 `location.origin` 不以 `http` 开头
      （否则会误判成浏览器模式、不存 `_as`）。
- [ ] **localStorage 持久**：登录后杀进程重进仍免登录（`_ak`/`_as` 没丢）。
- [ ] **跨域 API**：REST 列表/消息能从 resource origin 调通远程 `https://<server>/api/...`。
- [ ] **WebSocket 实时**：发消息、流式 typewriter、权限弹窗实时到达。
- [ ] **前台恢复重连**：锁屏/切后台几分钟再回来，WS 自动重连补消息
      （前端 `web/js/ws.js` 靠 `visibilitychange/pageshow/focus` 触发，需确认 ArkWeb 语义能触发）。
- [ ] **返回键**：有历史时后退、首页时退出（`onBackPress` 已实现）。
- [ ] **安全区**：顶栏不被状态栏/刘海遮挡。
- [x] **扫码登录**：landing 页扫码按钮出现，扫 setup 页二维码即登录（即门面 + 前端展开
      这条注入链路可用）。
- [x] **Remote preview 的两个平台前提**：ArkWeb 能连本应用监听的 `127.0.0.1`（鸿蒙沙箱放行
      应用内 loopback），且 `MixedMode.All` 下 `app://` 页面里的 http iframe 不被当 mixed
      content 拦掉 —— 真机已验证，预览页面正常渲染。
      其余细项待逐项确认：输入非法端口报错、未监听的端口显示 "Port N is not listening"、
      设备胶囊刷新、「Open in browser」拉起系统浏览器、删除连接后页面关闭、
      杀进程重进不残留占用端口。
- [ ] **native-mobile 判定生效**：① 终端里长按屏幕 450ms 出方向摇杆，滑动能连发方向键；
      ② 软键盘弹起时终端底部出现 Esc/Tab/Ctrl/… 按键条（它靠 `visualViewport` 收缩推导
      `keyboard-open`，若没出现，多半要给 `Index.ets` 的 Web 显式加
      `.keyboardAvoidMode(WebKeyboardAvoidMode.RESIZE_VISUAL)`）；③ 顶栏没有多余留白
      （iOS 那条 59px 补偿写在 `@supports (-webkit-touch-callout:none)` 里，假定 Blink 不支持
      该属性所以对鸿蒙无效，若顶栏突然空一截就是这里）；④ 竖屏/横屏顶栏仍在、能返回；
      ⑤ 列表与消息字号、点击区变大后无错位。
- [x] **文件下载主路径**：查看文件 → 点下载 → 百分比 → 系统保存框 → 文件落到「下载」里。
      另外两点仍需真机确认：① 取消保存框时状态行应**静默清空**，若你的 SDK 版本把取消报成异常码
      （不是空数组、也不是 13900020），`DownloadBridge.isCancel()` 要补上那个码；
      ② 大文件（>100 MB）下载中途切后台再回来，应正常完成或给出明确报错，不能一直转圈。

## 已知降级（Tauri 原生能力暂缺，均 feature-detect 不崩）

- iOS 语音输入 → 平台特有，不适用。
- 扫码登录（ScanKit）、文件下载（DownloadBridge）、Remote preview + 外链
  （PreviewBridge / OpenBridge）已实现，不再是降级项。
- 移动端 UI / 终端按键条 + 方向摇杆已不再降级（见上面的 native-mobile 一节），
  但横屏顶栏隐藏与边缘返回手势这两条 Tauri 行为在鸿蒙上尚未验证。
- Remote preview 的两处行为差异（都写在上面那节）：没有半关闭 → 远端 FIN 会关掉整条连接，
  keep-alive 复用变成新建连接；本地端口可能不等于远程端口（鸿蒙 `listen()` 占用时会随机换
  端口，Tauri 是向前顺序找），不影响功能，只是列表里 Local port 与 Remote port 更容易不同。
