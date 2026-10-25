# Synora code

**本项目 100% 由 Codex 编写。**

面向 Windows 的多模型 AI 编程助手，在本机管理项目、会话和模型连接。

项目作者：[兴汉1](https://github.com/xinghan1) · AI 编程协作：ChatGPT / Codex。

## 主要功能

- **多模型接入**：支持 OpenAI、DeepSeek、Gemini、Kimi、GLM / 智谱 / Z.AI、Claude、兼容 API 中转和 Ollama；支持 ChatGPT、DeepSeek 账号授权，以及 Antigravity、Kimi Code、ZCode 完整官方代理。
- **项目开发**：按行分页读取、搜索和编辑文件，运行命令，预览代码与修改，支持任务撤销、内置浏览器及子智能体；默认搜索跳过 Maven `target` 等构建目录。
- **对话辅助**：多会话管理、图片输入、侧边临时问答、Tab 提示词补齐和每轮结束后的下一步建议。
- **桌面宠物**：左键与“大肥鱼”聊天，动作优先使用模型回应，不可用时使用固定台词；明确的项目制作需求会润色后转交主会话，宠物可单独配置模型。
- **上下文与用量**：显示上下文占用及系统提示、工具定义和对话消息的用量分布，可手动设置模型容量，接近有效容量时自动压缩，保留完整本地记录。
- **个性化与扩展**：六种界面风格、自定义背景、颜色风格、桌面宠物和本地开发者插件。
- **权限与更新**：请求批准、AI 帮助审批和完全控制模式；安装版支持检查、下载和校验更新。

关闭窗口后，软件会保留在右下角系统托盘，正在运行的模型任务继续执行；点击托盘图标恢复窗口，右键选择“退出应用”结束后台运行。

从 [GitHub Releases](https://github.com/xinghan1/Synora-code/releases/latest) 下载 Windows x64 安装包，无需安装 Node.js。发布资源中的同名 `.exe.sha256` 文件用于核对安装包 SHA-256。账号、API Key 和会话保存在本机，不随源码或发布包分发。

## 模型连接

在 **模型设置** 中选择服务商和连接方式。API Key 模式由 Synora 管理模型请求与工具；官方代理模式由对应官方程序完整执行主会话任务，Synora 显示过程并转交审批、提问及停止操作。

| 服务商 | API Key | 官方代理账号登录 |
| --- | --- | --- |
| Google · Gemini | Google AI Studio 原生 Gemini API | Antigravity 官方代理，浏览器登录 Google 账号 |
| Kimi | 默认 `https://api.moonshot.cn/v1`；国际地址可自行填写 | Kimi Code 官方代理，可选择中国大陆或国际账号 |
| GLM / 智谱 / Z.AI | 默认 `https://open.bigmodel.cn/api/paas/v4`；国际与 Coding Plan API 地址可自行填写 | ZCode 官方代理，可选择智谱中国大陆或 Z.AI 国际账号 |

账号连接流程：选择官方代理连接方式及地区 → 准备官方组件 → 在官方页面登录 → 刷新模型目录 → 选择模型并保存。Antigravity 与 Kimi 的原版组件从官方地址按需下载并校验；ZCode 组件随安装包提供，首次使用复制到本机运行目录。安装组件本身不会登录账号。切换地区后需要连接对应地区账号，原先保存的 API Key、API 地址和 API 模型会保留。

可用模型、会员 / Coding 套餐资格、额度及地区限制以官方账号实际返回为准，API Key 计费与订阅额度不能自动互换。控制台登录按钮只打开官方页面，不代表已向 Synora 授权。官方代理模式目前仅用于主会话；使用子智能体、AI 审批、Tab 补齐、侧栏问答或宠物模型时，需在 **设置 → 模型分工** 为对应功能单独配置可用连接。

Google 已于 [2026 年 6 月 18 日停止个人、AI Pro 和 Ultra 的旧 Gemini CLI 服务](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)。保留的“旧 Gemini CLI · 兼容连接”入口仅适用于 Google 服务端仍支持的账号；个人账号可选择完整 Antigravity 官方代理，其可用资格与额度仍由 Google 决定。

## 插件开发

插件使用本地 HTML、JavaScript 和 CSS，可通过开发面板及命令扩展功能。软件内进入 **设置 → 插件管理… → 创建示例插件**，编辑后安装并启用。

- [开发文档](docs/PLUGIN_DEVELOPMENT.md)：清单、权限、API、运行与分发说明。
- [API 类型定义](sdk/plugin-api.d.ts)：`window.synoraPlugin` 接口。
- [示例插件](examples/hello-plugin)：项目文件读取、文本修改和通知示例。

## 源码构建

需要 **Windows x64、Node.js 22.12+ 和 npm**，在 PowerShell 执行：

```powershell
git clone https://github.com/xinghan1/Synora-code.git
cd Synora-code
npm.cmd ci
npm.cmd run prepare:sdk
npm.cmd run prepare:gemini
npm.cmd run prepare:zcode
npm.cmd test
npm.cmd start
```

构建分发包：

```powershell
npm.cmd run build             # 便携版，输出到 dist/
npm.cmd run build:installer   # 安装包及 SHA-256 文件，输出到 installer-output/
```

两种构建可分别执行；便携版需保留整个输出目录，重新构建前请改名留存同名旧目录。首次安装依赖或构建需要联网下载 Electron，构建不会自动发布 GitHub Release。

`prepare:zcode` 基于固定提交 `3c5b227649371507ddc4eb46ac5133afe6db1cab` 构建 ZCode CLI 0.17.0 兼容组件，并应用 [独立账号初始化补丁](scripts/patches/zcode-standalone-account.mjs)。该补丁让 `app-server` 使用上游已有的独立账号服务及请求鉴权端口，账号凭据仍由组件内部管理；不改变 OAuth 客户端身份、账号权限、模型定义或工具审批。补丁文件与修改前后源码均校验 SHA-256，产物来源文件明确记录这项修改。

脚本自动准备隔离的 Node.js 24.14.0 和 pnpm 10.33.2，校验工具链、安装上游锁定依赖并生成保留全部上游资源收集器的 Windows x64 SEA 程序；无需修改全局 Node.js 或 pnpm。此步骤需联网，首次构建比安装普通依赖耗时更长。产物、来源与 SHA-256、补丁说明、许可证和第三方声明位于 `src/vendor/zcode-agent/`，构建分发包前需要完成该步骤。

ChatGPT 登录组件采用随附的非商业许可，其他组件及素材遵循各自许可，详见 [第三方组件说明](THIRD_PARTY_NOTICES.md)。
