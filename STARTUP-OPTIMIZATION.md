# 启动优化 + 列表缓存设计

> AgentPeek 是 Tauri v2 包裹的静态 web 前端(纯 vanilla JS + Vite)。本文记录 iOS
> 冷/热启动的现状分析、可落地的优化项,以及列表页的 stale-while-revalidate 缓存设计。
> 均为**方案文档**,实施前需按 CLAUDE.md 的 workflow rule 确认。

---

## 一、启动路径现状(已优化的部分)

前端首屏其实已经做了不少功夫,先记清楚**哪些不用再动**:

- ✅ **内联 critical CSS**(`index.html` `<style>`)—— 防 FOUC,首屏骨架不等外部 CSS。
- ✅ **内联 shell 脚本在 HTML 解析期就并行发 fetch**(`active-sessions` + `devices`),
  不等 JS 模块下载;`whenContentReady` 轮询 `#content` 而非等 `DOMContentLoaded`。
- ✅ **重库懒加载**(marked / hljs / diff / diff2html ≈ 1.3MB)—— `globals.js`
  `loadViewerLibs()`,首页完全不付这个下载代价。
- ✅ **WS 首页不连接** —— 纯 REST;`ws.js` 只在打开 session 时才 `connectWs()`。
- ✅ **preload 结果复用** —— 内联 shell 的两个 fetch 被 `app.js` `loadDevices()`
  复用(`window.__preload`),没有重复请求。
- ✅ **热启动即时** —— 后台→前台(webview 未被回收)只做 WS 重连 + `recoverMissing`,
  不重载。仅当 iOS 内存压力回收 webview 时才退化为冷启动。

所以 JS 层的"低垂果实"基本摘完,剩下的瓶颈在网络首屏、Rust 二进制、原生插件 init。

---

## 二、可落地的优化项(按 收益 ÷ 风险 排序)

| 优先级 | 改动 | 文件 | 风险 |
|---|---|---|---|
| 🥇 | **列表页本地缓存(SWR)** —— 冷启动即时出内容而非空屏等网络 | `index.html` 内联 shell + `app.js` + 新 helper | 低 |
| 🥇 | **加 `[profile.release]`** —— 缩小 Rust 二进制 → 加快 dyld 加载 | `src-tauri/Cargo.toml` | 极低(纯配置) |
| 🥈 | **延迟 speech 插件 init** 到首次语音使用,摘出冷启动关键路径 | `src-tauri/src/lib.rs` | 低 |
| 🥉 | **深链拆分 viewer bundle** —— 文本先渲染,diff2html/hljs 后到 | `globals.js` / `app.js` | 中(需真机验证) |
| 🥉 | **缩短/自适应 iOS 150ms body reveal** 延迟 | `index.html` | 中(视觉回归) |

### 2.1 🥇 列表页本地缓存(SWR)—— 详见第三节

单项感知收益最大。当前所有列表页每次冷启动都是"白屏等网络",蜂窝射频唤醒本身
就 1–2s。加本地缓存后,冷启动**即时出上次的内容**,网络回来再 reconcile。

### 2.2 🥇 Rust release profile

`src-tauri/Cargo.toml` 目前**完全没有 `[profile.release]`**。iOS 冷启动第一步就是
dyld 加载 Rust 静态库,体积直接影响 pre-main 时间。加上:

```toml
[profile.release]
opt-level = "s"      # 优化体积(不是速度)
lto = true           # 链接期优化,显著缩小
codegen-units = 1
strip = true         # 去符号表
panic = "abort"      # 去掉 unwind 表
```

纯配置改动,缩小二进制 → 加快加载。**风险极低。**

### 2.3 🥈 延迟 speech 插件 init

`src-tauri/src/lib.rs` 在 `setup()` 里**无条件**初始化 barcode-scanner + speech
插件(iOS 段),发生在任何 UI 出现之前。speech 只在用户点语音输入时才用,可延迟到
首次使用再 init,把它从冷启动关键路径上摘掉。barcode-scanner 同理(仅 landing 扫码用)。

### 2.4 🥉 深链拆分 viewer bundle

从 session URL 冷启动时,`app.js` 会 await 整个 `loadViewerLibs()`(~1.3MB)才渲染
消息。可进一步拆分:纯文本消息先渲染,最重的 diff2html / highlight.js 后到。
收益仅限"直接深链进 session"的冷启动,优先级中低。

### 2.5 🥉 iOS body reveal 延迟

`index.html` 末尾 `setTimeout(revealReady, 150)` —— 为等 WKWebView frame 稳定硬加的
150ms(防状态栏跳动)。可改成"DOMContentLoaded 后更短延迟 + 首帧即揭示"的自适应策略。
**有视觉回归风险(顶栏可能闪一下),需真机验证,优先级最低。**

### 关于热启动

热启动(后台→前台且 webview 未被回收)已是即时,JS 层无可优化空间。若 iOS 因内存
压力回收了 webview,则等同冷启动,由上面 2.1 / 2.2 覆盖。

---

## 三、列表缓存设计(stale-while-revalidate)

### 3.1 目标

把首页缓存的思路**统一应用到所有列表页**(home / projects / sessions),用一个统一
封装的取数方法:先读 localStorage 即时渲染,同时请求网络,回来后 reconcile。核心目标是
**平时完全静默即时,只有真慢的时候才提示"在刷新"**。

### 3.2 统一 helper

```
swrList(cacheKey, url, { render, onFresh })
  1. 读 localStorage[cacheKey]
       ├─ 命中且 schema version 匹配 → 立即 render(cached)
       └─ 未命中 / version 不匹配   → render 骨架屏
  2. fetch(url)
  3. 网络回来:
       ├─ JSON.stringify(fresh) === cachedRaw → 什么都不做(零闪烁)
       └─ 有变化 → render(fresh) + 写回 localStorage
```

所有列表页共用。骨架屏**只在真正冷未命中时出现**,命中就直接出内容。

### 3.3 更新时的 UX —— 不用常驻 spinner

用户提出"更新时放个转圈 loading 按钮提示看到的是缓存"。经讨论,**常驻 spinner 不是
最优解**,采用下面这套组合(体感更干净):

**① 比对跳过(最重要)**
网络回来后 `JSON.stringify(fresh) === cachedRaw` 就**什么都不做**。列表页绝大多数
revalidate 其实数据没变 → 用户完全看不到任何变化。这一条解决 ~80% 场景。

**② 数据真变了才更新,且变化是用户想看到的**
这是**监控类** app,状态 running→done、新 session 冒出来,正是用户打开想知道的。
"旧→新"过渡不是 bug 是 feature,只要别让它跳:
- 更新时**保留 `scrollTop`**(sessions 列表可能很长)。
- 变化的行做**极轻微高亮淡出**(GitHub 那种背景闪一下),而非整页 `innerHTML` replace 闪一下。
- **不做逐行 diff-patch**(v1)—— 列表不大(设备几个、session 几十),"比对跳过 +
  保留 scrollTop + 变化行高亮"已足够顺;diff-patch 是过度工程,等实测觉得卡再上。

**③ 延迟出现的 spinner(deferred indicator),而非常驻**
- revalidate 一发出就起计时器,**只有超过 ~500ms 还没回来**才显示 spinner;回来了就取消。
- 快网络 → spinner 从不出现(静默);慢网络/离线 → 才提示"你看的是缓存,新数据在路上"。
- 位置**内联在 section 标题里**(如 `Devices (3) ⟳`),比全局 spinner 更贴合上下文、
  更不打扰。

> 为什么不常驻:缓存命中 + 网络快时 revalidate 常 200ms 就回来,只闪 200ms 的 spinner
> 比不显示更难受(flicker),每次导航都转一下用户很快学会无视。

### 3.4 必须处理的正确性问题

1. **缓存 key 按账号隔离** —— 用 apiKey 的 hash 做前缀,否则换 key / 多账号会串数据。
2. **缓存带 schema 版本号** —— 列表结构以后改了,老缓存不能直接喂给新渲染函数导致
   报错;version 不匹配就当未命中。**TTL 可以不要**(反正每次都 revalidate)。

### 3.5 v1 范围结论

统一 SWR helper + 「比对跳过 + 保留 scrollTop + 变化行轻高亮」+ **延迟 spinner**
(非常驻)。**先不做逐行 diff-patch。**

---

## 四、实施建议顺序

1. **Cargo release profile**(2.2)—— 独立、零风险,可先合。
2. **列表 SWR 缓存**(2.1 + 第三节)—— 感知收益最高。
3. **speech 延迟 init**(2.3)—— 与上面一起做很干净。
4. (可选,后续)深链 bundle 拆分(2.4)、iOS reveal 自适应(2.5)—— 需真机验证。

> 每项写代码前给出 precise diff 级提案(改哪行、改成什么、为什么),确认后再动手。
