# Cortex

**本项目 100% 由 Codex 编写。**

面向 Windows 的多模型 AI 编程助手，在本机管理项目、会话和模型连接。

项目作者：[兴汉1](https://github.com/xinghan1) · AI 编程协作：ChatGPT / Codex。

## 主要功能

- **多模型接入**：支持 OpenAI、DeepSeek、Gemini、Kimi、GLM / 智谱 / Z.AI、豆包 / 火山方舟、Claude、兼容 API 中转和 Ollama；支持 ChatGPT、DeepSeek 账号授权，以及 Gemini、Kimi、GLM、Claude 官方组件和火山方舟账号登录。
- **项目开发**：按行分页读取、搜索和编辑文件，运行命令，预览代码与修改，支持任务撤销、内置浏览器及子智能体；默认搜索跳过 Maven `target` 等构建目录。
- **对话辅助**：多会话管理、运行中增量保存与异常中断恢复、图片输入、本地截图视觉核对与查看记录（需模型支持图片）、侧边临时问答、Tab 提示词补齐和每轮结束后的下一步建议。
- **桌面宠物**：左键与“大肥鱼”聊天，动作优先使用模型回应，不可用时使用固定台词；明确的项目制作需求会润色后转交主会话，宠物可单独配置模型。
- **上下文与用量**：显示上下文占用及系统提示、工具定义和对话消息的用量分布，可手动设置模型容量，接近有效容量时自动压缩，保留完整本地记录。
- **个性化与扩展**：六种界面风格、自定义背景、颜色风格、桌面宠物和本地开发者插件。
- **权限与更新**：请求批准、AI 帮助审批和完全控制模式；安装版支持检查、下载和校验更新。

关闭窗口后，软件会保留在右下角系统托盘，正在运行的模型任务继续执行；点击托盘图标恢复窗口，右键选择“退出应用”结束后台运行。

从 [GitHub Releases](https://github.com/xinghan1/Cortex/releases/latest) 下载 Windows x64 安装包，无需安装 Node.js。发布资源中的同名 `.exe.sha256` 文件用于核对安装包 SHA-256。账号、API Key 和会话保存在本机，不随源码或发布包分发。

## 模型连接

在 **模型设置** 中选择服务商和连接方式。API Key 模式由 Cortex 管理模型请求与工具；官方代理模式由对应官方程序完整执行主会话任务，Cortex 显示过程并转交审批、提问及停止操作。

| 服务商 | API Key | 账号登录 |
| --- | --- | --- |
| ChatGPT / OpenAI | OpenAI API | ChatGPT 官方账号授权 |
| DeepSeek | DeepSeek API | DeepSeek 官方账号授权 |
| Google · Gemini | Google AI Studio 原生 Gemini API | Antigravity 官方代理，浏览器登录 Google 账号 |
| Kimi | 默认 `https://api.moonshot.cn/v1`；国际地址可自行填写 | Kimi Code 官方代理，可选择中国大陆或国际账号 |
| GLM / 智谱 / Z.AI | 默认 `https://open.bigmodel.cn/api/paas/v4`；国际与 Coding Plan API 地址可自行填写 | ZCode 官方代理，可选择智谱中国大陆或 Z.AI 国际账号 |
| 豆包 / 火山方舟 | 默认 `https://ark.cn-beijing.volces.com/api/v3`，Chat Completions | 官方 Ark CLI 浏览器授权后，明确选择 API / Agent Plan / Coding Plan 配置 |
| Anthropic · Claude | Claude Messages API | 本机官方 Claude Code / Agent SDK 完整执行主会话 |

账号连接流程：选择“账号登录”及对应地区 → 准备官方组件 → 在官方页面登录 → 刷新模型目录 → 选择模型并保存。Antigravity 与 Kimi 的原版组件从官方地址按需下载并校验；ZCode 组件随安装包提供，首次使用复制到本机运行目录。Claude SDK 与 Ark CLI 官方组件随包提供并校验完整性，安装组件本身不会登录账号。切换地区后需要连接对应地区账号，原先保存的 API Key、API 地址和 API 模型会保留。

可用模型、会员 / Coding 套餐资格、额度及地区限制以官方账号实际返回为准，API Key 计费与订阅额度不能自动互换。控制台登录按钮只打开官方页面，不代表已向 Cortex 授权。官方代理模式目前仅用于主会话；使用子智能体、AI 审批、Tab 补齐、侧栏问答或宠物模型时，需在 **设置 → 模型分工** 为对应功能单独配置可用连接。

推理滑条只显示官方组件为当前模型提供的档位，并保留官方名称、顺序与真实值；没有提供可选档位时显示“由官方代理管理”。切换模型会重新核对能力，恢复默认时交回官方设置，不通过提示词模拟推理强度。

火山方舟账号入口对应方舟 API / Agent Plan / Coding Plan，并非豆包 App 聊天账号。浏览器授权后，将官方页面显示的授权码粘贴回软件，再明确选择官方返回的配置；按量 API 会单独标识，不会在套餐不可用时自动切换计费方式。配置中的运行时 Key 由官方 CLI 安全导出并使用系统加密保存。当前支持北京区域，详见 [账号接入说明](docs/ARK_ACCOUNT.md) 与 [豆包 API 说明](docs/doubao-ark-integration.md)。

Claude 登录由官方原生程序完成，不提取 OAuth Token 或将其转换为 API Key；第三方产品账号接入仍受 [官方 SDK 的授权要求](https://code.claude.com/docs/en/agent-sdk/overview)约束，不保证某个订阅具备调用资格。模型目录不代表推理或套餐权益已通过验证。

Google 已于 [2026 年 6 月 18 日停止个人、AI Pro 和 Ultra 的旧 Gemini CLI 服务](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)。模型设置只提供 Gemini API Key 和 Antigravity 官方代理两种新建入口；已有旧连接的本机资料继续保留，Antigravity 的可用资格与额度仍由 Google 决定。

## 插件开发

插件使用本地 HTML、JavaScript 和 CSS，可通过开发面板及命令扩展功能。软件内进入 **设置 → 插件管理… → 创建示例插件**，编辑后安装并启用。

- [开发文档](docs/PLUGIN_DEVELOPMENT.md)：清单、权限、API、运行与分发说明。
- [API 类型定义](sdk/plugin-api.d.ts)：`window.synoraPlugin` 接口。
- [示例插件](examples/hello-plugin)：项目文件读取、文本修改和通知示例。

## 源码构建

需要 **Windows x64、Node.js 22.12+ 和 npm**，在 PowerShell 执行：

```powershell
git clone https://github.com/xinghan1/Cortex.git
cd Cortex
$env:CI = '1'                  # 避免 Ark CLI 安装附带技能到其他软件
npm.cmd ci
npm.cmd run prepare:sdk
npm.cmd run prepare:gemini
npm.cmd run prepare:zcode
npm.cmd run prepare:accounts  # 校验 Claude / Ark 官方组件
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
