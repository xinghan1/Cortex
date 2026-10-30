# 第三方组件说明

## OpenAI Sign-in with ChatGPT DevKit

来源：<https://github.com/openai/sign-in-with-chatgpt-devkit>

所用上游提交：`0a36fefeb913055c8c7a1a29b63d82b96b2e841a`。

本仓库在 `vendor/siwc-devkit/` 保留本机登录组件的源代码、测试、编译配置和许可文件。`npm run prepare:sdk` 生成的运行时代码位于 `src/vendor/siwc/`，并随构建复制许可证和第三方声明。

该组件采用 **SIGN-IN WITH CHATGPT DEVKIT NONCOMMERCIAL LICENSE, Version 1.0**，仅许可非商业用途。原文见 [SDK 许可证](vendor/siwc-devkit/LICENSE)，依赖声明见 [SDK 第三方声明](vendor/siwc-devkit/THIRD_PARTY_NOTICES.md)。此许可不授予 OpenAI 品牌、商标或服务访问权。

本项目修改了 `packages/local/src/index.ts`、`packages/local/src/types.ts` 和 `packages/local/src/models.ts`，增加仅在 Electron 主进程内使用的 `withAccessToken` 回调，并保留经校验的模型上下文容量供本地预算使用；修改文件均保留说明。对该 SDK 的修改按同一非商业许可证分发。OAuth 校验、权限检查、凭据轮换和取消流程仍使用原组件实现。Cortex 当前将此接入用于本机个人实验；商业使用该组件需要另行获得许可。

## dsh-pet 桌面宠物素材

来源：<https://github.com/PC2005-cloud/dsh-pet>，上游版本 `0.3.8`，固定提交 `86bc30c83225919434de8396073078dc22e926fd`。

本软件通过 Cortex 适配层使用原版透明 WebM 动画、动作配置和本地宠物包；内置 11 段未修改的上游动画（共 4,660,934 字节），用于待机、互动及任务状态。素材与配置保存在 `src/vendor/dsh-pet/`，该目录的 `provenance.json` 记录来源、大小与 SHA-256。

上游采用 MIT License，Copyright (c) 2026 PC2005-cloud。完整许可与来源声明见 `src/vendor/dsh-pet/LICENSE` 和 `src/vendor/dsh-pet/NOTICE.md`，随安装包一并保留。

## DeepSeek 账号授权协议

Cortex 的 DeepSeek 账号接入参考 [DeepSeek Harness 官方账号授权实现](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/deepseek-account-platform) 和 [账号模型适配](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-deepseek-account)，使用本软件自己的客户端标识与独立实现。

上游采用 MIT License，Copyright (c) 2026 DeepSeek。许可与来源说明位于 `src/vendor/deepseek-account/LICENSE` 和 `src/vendor/deepseek-account/NOTICE.md`，随程序保留。

## 其他依赖

### Google Antigravity 官方代理

本软件通过公开 ACP 协议连接 Google 原版 Antigravity 1.4.3 完整代理，由该代理管理自己的登录、模型与工具执行。代理程序不随 Cortex 安装包分发，用户首次使用时从 Google 官方地址下载并校验 ZIP 及解包文件 SHA-256。原始发布地址与校验值见 [ACP Registry 的 Antigravity 条目](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)，本地固定值见 `src/core/antigravity-runtime.mjs`。

Antigravity 是 Google 的专有软件，适用 [Google Antigravity 服务条款](https://antigravity.google/terms)，不因 Cortex 的适配而改用开源许可。Cortex 不分发其账号凭据，不将其内部授权令牌转换为通用 API Key。应用配置与会话目录独立；官方系统凭据存储可能与其他 Google 官方客户端共用，断开 Cortex 本机连接不会执行系统级退出登录。

### Kimi Code 官方代理

来源：[MoonshotAI / Kimi CLI](https://github.com/MoonshotAI/kimi-cli)，上游源码采用 [Apache License 2.0](https://github.com/MoonshotAI/kimi-cli/blob/main/LICENSE)。Cortex 按需下载 Moonshot 官方 Windows x64 二进制 2.3.1，不随安装包重新分发该二进制。下载来源为 `https://code.kimi.com/kimi-code/binaries/2.3.1/kimi-code-win32-x64.exe`，SHA-256 依据 [官方版本清单](https://code.kimi.com/kimi-code/binaries/2.3.1/manifest.json) 固定在 `src/core/kimi-runtime.mjs`。

软件使用原版登录命令与 ACP 协议，由官方代理完整执行任务。中国大陆与国际账号使用各自官方授权流程，每次授权使用独立本机目录；Cortex 不读取、导出或重用其账号令牌。服务访问与套餐额度仍受 Moonshot 官方账号条款约束。

### ZCode 官方代理

来源：[zai-org / ZCode](https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab)，固定提交 `3c5b227649371507ddc4eb46ac5133afe6db1cab`，CLI 版本 0.17.0，上游采用 Apache License 2.0，Copyright 2026 Z.AI Co., Ltd。

`npm run prepare:zcode` 从该提交构建完整 Windows x64 SEA 兼容组件，保留上游运行资源收集器与 `app-server` 协议。Cortex 于 2026-10-25 对 `zcode-protocol-entrypoint.ts` 应用了一项明确披露的兼容修改：在本软件单独传入 `SYNORA_ZCODE_STANDALONE_ACCOUNT=1` 时，连接上游已有的独立账号服务与请求鉴权端口。未设置该开关时保留原先的桌面工作进程行为。

此组件不是未经修改的上游原版二进制。补丁不改变 OAuth 客户端身份、服务地址、账号权限、模型定义、工具执行或权限审批；账号认证材料始终由组件内部的上游代码管理，不导出给 Cortex。Cortex 通过原生协议转交会话、权限与用户问题。随包文件位于 `src/vendor/zcode-agent/`：

- `zcode-windows-x64.exe`：完整代理程序，包含上游构建收集的运行资源。
- `provenance.json`：上游提交、版本、工具链校验值与产物 SHA-256。
- `LICENSE`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`：原版许可、来源和完整依赖声明。
- `SYNORA-PATCHES.md`、`synora-standalone-account.mjs`：修改说明和精确补丁；`provenance.json` 记录补丁及修改前后源码 SHA-256。
- `NODE-LICENSE.txt`：SEA 内嵌的 Node.js 24.14.0 运行时完整许可。

各内嵌依赖保持原许可。该源码许可不授予 Z.AI 品牌、账号、订阅或服务访问权。

用于精确初始化和模型选择回归测试的未修改上游源码位于 `tests/fixtures/` 中的三个 `zcode-*-v0170.ts` 文件；同目录的 `zcode-v0170-LICENSE` 与 `NOTICE.md` 保留其 Apache 2.0 许可、固定来源和测试用途说明。

### Google Gemini CLI

Google 官方 Gemini CLI 0.65.0 以原版程序随软件分发，采用 Apache License 2.0；来源为 [官方仓库](https://github.com/google-gemini/gemini-cli/releases/tag/v0.65.0) 及官方 npm 发布包。软件通过公开 ACP 协议调用它，不复制登录令牌或 OAuth 客户端实现。原版许可证及运行资源保留在 `src/vendor/gemini-cli/`，`provenance.json` 记录发布包完整性与文件哈希。生成目录由 `npm run prepare:gemini` 还原。

应用的 npm 依赖及精确版本见 `package.json` 与 `package-lock.json`。安装后各依赖目录内保留其许可文件。Windows 便携构建复制 Electron 运行时随附的 `LICENSE`、`LICENSES.chromium.html` 及运行依赖的许可文件。

本说明不改变各第三方组件的许可证，也不将它们重新许可为 MIT 或其他许可证。


### Claude Agent SDK 与官方 Claude Code

采用官方 npm `@anthropic-ai/claude-agent-sdk` 0.3.310 及其 Windows x64 平台包，内含 Claude Code 2.1.310。SDK 和原生程序保持原版，来源、完整性锁定在 `package-lock.json`，原生程序大小与 SHA-256 固定在 `src/core/claude-runtime.mjs`。组件的版权归 Anthropic PBC，适用包内 `LICENSE.md` 指向的 [官方法律协议](https://code.claude.com/docs/en/legal-and-compliance)，不改用本项目许可。

登录由原生 `claude auth login --claudeai` 完成，账号状态由原生 `auth status` 验证；完整代理负责模型和工具执行，Cortex 仅通过官方 SDK 转交任务、审批和停止。Cortex 不实现、冒用或修改 OAuth 客户端，不读取或重放 OAuth Token，不保证第三方工具具备某套餐的使用资格。第三方产品提供账号登录须遵循 [官方 SDK 的授权要求](https://code.claude.com/docs/en/agent-sdk/overview)，模型和计费最终由官方服务判定。

### 火山方舟 Ark CLI

来源：[volcengine / ark-cli](https://github.com/volcengine/ark-cli)，官方 npm `@volcengine/ark-cli` 1.0.42，Apache License 2.0。原生 Windows x64 组件由官方安装脚本从官方发布渠道取得并按包内 `manifest.json` 校验 SHA-256；构建时使用 CI 模式，只准备二进制，不安装附带技能到其他软件。组件未修改。

Cortex 使用公开的浏览器登录、账号状态、Profile、资源目录和 `profile apikey get --plain` 命令。用户明确选择账号配置后，将该配置的运行时 Key 交给本机系统加密存储，用于同一官方 Profile 的 API 调用；不提取 SSO Token、不读取浏览器 Cookie，也不会把豆包 App 个人聊天账号冒充方舟 API 授权。
