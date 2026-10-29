# <sub><picture><source media="(prefers-color-scheme: dark)" srcset="web/public/assets/baton-logo.svg"><img src="web/public/assets/baton-logo-dark.svg" width="36" height="36" alt=""></picture></sub>Baton

[English](README.md) | **中文**

在手机上接着处理电脑上的 [Claude Code](https://github.com/anthropics/claude-code) 和 [Codex](https://openai.com/codex) 任务，无缝延续工作进度。

<p align="center">
  <img src="docs/assets/promo.avif" alt="Baton" width="100%">
</p>

Baton 无需改变你使用 Claude Code 和 Codex 的方式，即可在多个设备上实时同步和展示会话。会话数据保存在你自己的 AWS 账户中。

### 开发工具

<p align="center">
  <picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/project-files.avif" width="48%"><img src="docs/assets/showcase/project-files.avif" alt="项目文件" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/git.avif" width="48%"><img src="docs/assets/showcase/git.avif" alt="Git 变更" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/tools-mobile.svg" width="100%"><img src="docs/assets/showcase/empty.svg" alt="" width="1%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/terminal.avif" width="48%"><img src="docs/assets/showcase/terminal.avif" alt="移动端终端" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/remote-preview.avif" width="48%"><img src="docs/assets/showcase/remote-preview.avif" alt="远程预览" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/tools-mobile-second.svg"><img src="docs/assets/showcase/tools-desktop.svg" alt="" width="100%"></picture>
</p>

### 丰富的内容展示

<p align="center">
  <picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/permissions.avif" width="48%"><img src="docs/assets/showcase/permissions.avif" alt="权限审批" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/mermaid.avif" width="48%"><img src="docs/assets/showcase/mermaid.avif" alt="Mermaid 图表" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/rendering-mobile.svg" width="100%"><img src="docs/assets/showcase/empty.svg" alt="" width="1%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/inline-html.avif" width="48%"><img src="docs/assets/showcase/inline-html.avif" alt="内嵌 HTML 预览" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/empty.svg" width="2%" height="0"><img src="docs/assets/showcase/empty.svg" alt="" width="1%" height="0"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/file-preview.avif" width="48%"><img src="docs/assets/showcase/file-preview.avif" alt="文件预览" width="24%"></picture><picture><source media="(max-width: 600px)" srcset="docs/assets/showcase/rendering-mobile-second.svg"><img src="docs/assets/showcase/rendering-desktop.svg" alt="" width="100%"></picture>
</p>

---

## 快速开始

### 1. 部署服务器

需要安装 [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)，并具备创建 CloudFormation 堆栈的权限。

```bash
curl -fsSL https://raw.githubusercontent.com/zhu-xiaowei/baton/main/server/install.sh | bash
```

部署约需 6–8 分钟，成功后会输出 **Start URL** 和二维码。支持 `--region`、`--stack`、`--profile` 选项（通过 `bash -s --` 传入）。

### 2. 安装 Bridge

需要 [Node.js](https://nodejs.org/) 20.9 或更高版本。

1. 在浏览器中打开 **Start URL**（也可直接作为 Web 查看器使用）。
2. 在 Setup 页面复制 **Install bridge** 提供的一行安装命令。
3. 在运行 Claude Code 或 Codex 的电脑上执行该命令。

如果直接在 Windows 上安装，请以**管理员身份运行** PowerShell，再执行安装命令。

### 3. 下载 App

| iOS | Android | HarmonyOS（鸿蒙） | macOS | Windows |
|:---:|:---:|:---:|:---:|:---:|
| <img src="docs/assets/baton_ios.png" width="120"> | <img src="docs/assets/baton_android.png" width="120"> | <img src="docs/assets/harmonyos.png" width="120"> | <img src="docs/assets/macOS.png" width="120"> | <img src="docs/assets/windows.png" width="120"> |
| [TestFlight](https://testflight.apple.com/join/UekStGCA) | [Baton.apk](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.apk) | [构建与安装](harmony/README.zh-CN.md) | [Baton.dmg](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.dmg) | [Baton.exe](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.exe) |

下载 App 后，扫描二维码或输入 Start URL 即可开始使用。

---

## 功能

### 核心功能

- **支持 Claude Code 和 Codex** — 在统一的「设备 → 项目 → 会话」列表中管理两种运行环境。
- **实时同步** — 回复、思考过程和工具调用随生成过程实时显示。
- **跟踪已有会话** — 在电脑上照常使用 Claude Code 和 Codex，轻量级本地 Bridge 会同步实时进度，以及运行中、等待输入、已完成等状态。
- **与已有会话交互** — 从任意已连接设备发送后续消息、在执行过程中追加输入、中断当前任务并继续工作。
- **创建项目和会话** — 远程创建项目，启动 Claude Code、Codex 或 Claude 后台代理会话，断开连接后仍可继续跟踪。
- **权限审批与问题回答** — 批准或拒绝工具调用、回答问题、审核计划，支持 Codex 命令、文件和 MCP 权限审批。
- **斜杠命令与 Skills** — 输入 `/` 自动补全各运行环境的内置命令、自定义命令、Codex Skills 和已保存的提示词。
- **Codex Goals** — 使用 `/goal` 设置、暂停、恢复或清除线程目标，并实时跟踪代理自主继续执行的过程。
- **子代理** — 将 Claude Code 和 Codex 的嵌套子代理归入主会话，显示实时状态和层级化线程列表。
- **自有基础设施** — 一条命令部署到自己的 AWS 账户，会话数据始终保存在该账户中。

### 开发工具

- **项目文件** — 浏览源码并高亮指定行，使用系统原生功能下载或分享文件。
- **Git** — 查看变更，暂存、取消暂存或丢弃文件变更，提交、推送或发布分支，并通过分支图浏览历史差异。
- **终端** — 每个项目最多支持五个 Shell，跨设备实时共享，返回时恢复；提供移动端快捷键栏、长按方向键摇杆（拖动越远，重复越快）和平滑惯性滚动（需要 macOS / Linux Bridge）。
- **本地服务预览** — 点击会话中的链接或输入端口，即可在原生 App 中打开 Bridge 所在电脑的 `http://localhost:3000` 或其他本地端口，无需 SSH、端口转发或暴露公网。

### 快速、稳定、轻量

- **接近原生的 App 体验** — 原生启动画面与各阶段的骨架屏无缝衔接，无白屏闪烁；从屏幕边缘滑动返回时，可看到下层页面。
- **即时加载** — 列表、历史记录和项目数据先从本地页面缓存加载，再在后台刷新。
- **稳定传输** — 有序传输、自动重连和消息发送队列，让会话在移动网络不稳定或 App 切换到后台后仍能保持连贯。
- **轻量 App** — 基于 Tauri 构建的小体积原生安装包，以及适用于 HarmonyOS NEXT 的 ArkWeb 壳。
- **免维护 Bridge** — 支持 macOS、Linux 和 Windows 常驻运行，可将多台电脑连接到同一账户，并自动更新。

### 丰富的内容展示

- **执行时间线** — 工具调用与结果可折叠，完整输出按需加载。
- **差异、Mermaid 和 LaTeX** — 在实时输出过程中直接渲染。
- **会话内嵌 HTML** — 支持交互式预览，可展开至全屏并保留当前状态。
- **文件预览** — 预览项目或消息中的 Markdown、HTML、PDF、Office、图片和视频文件；HTML 页面会加载相对路径的 CSS、脚本和图片，无需本地服务器即可完整显示；消息中的图片直接展示，支持全屏打开和双指缩放。

### 更多功能

- **文件、图片与语音输入** — 添加文件附件、发送压缩图片，并在 iOS 上通过语音输入消息。
- **会话草稿** — 在同一设备上切换会话或重新打开 App 时，保留文字和已上传的附件。
- **会话管理** — 通过对应运行环境的原生能力重命名会话，长按可多选并删除会话或项目，也可同时删除本地文件。
- **设备管理** — 从 Baton 移除设备并停止其在线 Bridge，保留本地会话文件。
- **API key 轮换** — 支持通过 `--rotate-key` 轮换 API key，保留已有数据。
- **macOS 标签页** — 通过独立标签页同时处理多个会话。
- **Claude 用量分析** — 查看状态、设置、速率限制、Token 历史和模型用量图表。

---

## 架构

```text
┌────────────────┐               ┌────────────────┐               ┌──────────────────┐
│     Bridge     │ ◀────WS─────▶ │     Server     │ ◀────WS─────▶ │     App/Web      │
│ (local hosts)  │               │  (AWS APIs)    │               │  (phone/desktop) │
└────────────────┘               └───────┬────────┘               └──────────────────┘
                                         │
                                         ▼
                                 ┌────────────────┐
                                 │ DynamoDB + S3  │
                                 │ (data + media) │
                                 └────────────────┘
```

**Bridge** 在本地电脑上发现 Claude Code 和 Codex 会话，统一事件格式，保留主代理与子代理的关系，并处理本地代理控制、项目文件、Git 命令和终端进程。**Server** 负责身份验证和控制消息路由，在 DynamoDB 中存储会话与根线程数据，并通过 S3 提供同步的媒体文件。**App/Web** 在手机或电脑上加载缓存的历史记录，订阅会话和根代理更新，将嵌套线程归入主会话，并把用户操作发送给对应的本地运行环境。

---

## 为什么叫 Baton？

Baton 既是接力棒，也是指挥棒：你可以在另一台设备上接着工作，也可以远程指挥你的代理。

---

## 卸载

参见[卸载指南](scripts/uninstall/README.md)。

---

## 许可证

MIT
