# Synora code

**本项目 100% 由 Codex 编写。**

面向 Windows 的多模型 AI 编程助手，在本机管理项目、会话和模型连接。

项目作者：[兴汉1](https://github.com/xinghan1) · AI 编程协作：ChatGPT / Codex。

## 主要功能

- **多模型接入**：支持 OpenAI、DeepSeek、Claude、兼容 API 中转和 Ollama；支持 ChatGPT、DeepSeek 账号授权。
- **项目开发**：读取、搜索和编辑文件，运行命令，预览代码与修改，支持任务撤销、内置浏览器及子智能体。
- **对话辅助**：多会话管理、图片输入、侧边临时问答、Tab 提示词补齐和每轮结束后的下一步建议；宠物支持选项问答、自定义回答与临时闲聊，隐藏宠物时在输入区作答。
- **上下文与用量**：显示上下文占用及系统提示、工具定义和对话消息的用量分布，可手动设置模型容量，接近有效容量时自动压缩，保留完整本地记录。
- **个性化与扩展**：六种界面风格、自定义背景、颜色风格、桌面宠物和本地开发者插件。
- **权限与更新**：请求批准、AI 帮助审批和完全控制模式；安装版支持检查、下载和校验更新。

关闭窗口后，软件会保留在右下角系统托盘，正在运行的模型任务继续执行；点击托盘图标恢复窗口，右键选择“退出应用”结束后台运行。

从 [GitHub Releases](https://github.com/xinghan1/Synora-code/releases/latest) 下载 Windows x64 安装包，无需安装 Node.js。发布资源中的同名 `.exe.sha256` 文件用于核对安装包 SHA-256。账号、API Key 和会话保存在本机，不随源码或发布包分发。

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
npm.cmd test
npm.cmd start
```

构建分发包：

```powershell
npm.cmd run build             # 便携版，输出到 dist/
npm.cmd run build:installer   # 安装包及 SHA-256 文件，输出到 installer-output/
```

两种构建可分别执行；便携版需保留整个输出目录，重新构建前请改名留存同名旧目录。首次安装依赖或构建需要联网下载 Electron，构建不会自动发布 GitHub Release。

ChatGPT 登录组件采用随附的非商业许可，其他组件及素材遵循各自许可，详见 [第三方组件说明](THIRD_PARTY_NOTICES.md)。
