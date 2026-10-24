# 第三方组件说明

## OpenAI Sign-in with ChatGPT DevKit

来源：<https://github.com/openai/sign-in-with-chatgpt-devkit>

所用上游提交：`0a36fefeb913055c8c7a1a29b63d82b96b2e841a`。

本仓库在 `vendor/siwc-devkit/` 保留本机登录组件的源代码、测试、编译配置和许可文件。`npm run prepare:sdk` 生成的运行时代码位于 `src/vendor/siwc/`，并随构建复制许可证和第三方声明。

该组件采用 **SIGN-IN WITH CHATGPT DEVKIT NONCOMMERCIAL LICENSE, Version 1.0**，仅许可非商业用途。原文见 [SDK 许可证](vendor/siwc-devkit/LICENSE)，依赖声明见 [SDK 第三方声明](vendor/siwc-devkit/THIRD_PARTY_NOTICES.md)。此许可不授予 OpenAI 品牌、商标或服务访问权。

本项目修改了 `packages/local/src/index.ts` 和 `packages/local/src/types.ts`，增加仅在 Electron 主进程内使用的 `withAccessToken` 回调；两个文件均保留修改说明。对该 SDK 的修改按同一非商业许可证分发。OAuth 校验、权限检查、凭据轮换和取消流程仍使用原组件实现。Synora code 当前将此接入用于本机个人实验；商业使用该组件需要另行获得许可。

## dsh-pet 桌面宠物素材

来源：<https://github.com/PC2005-cloud/dsh-pet>，上游版本 `0.3.8`，固定提交 `86bc30c83225919434de8396073078dc22e926fd`。

本软件通过 Synora 适配层使用原版透明 WebM 动画、动作配置和本地宠物包；内置 11 段未修改的上游动画（共 4,660,934 字节），用于待机、互动及任务状态。素材与配置保存在 `src/vendor/dsh-pet/`，该目录的 `provenance.json` 记录来源、大小与 SHA-256。

上游采用 MIT License，Copyright (c) 2026 PC2005-cloud。完整许可与来源声明见 `src/vendor/dsh-pet/LICENSE` 和 `src/vendor/dsh-pet/NOTICE.md`，随安装包一并保留。

## DeepSeek 账号授权协议

Synora code 的 DeepSeek 账号接入参考 [DeepSeek Harness 官方账号授权实现](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/deepseek-account-platform) 和 [账号模型适配](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-deepseek-account)，使用本软件自己的客户端标识与独立实现。

上游采用 MIT License，Copyright (c) 2026 DeepSeek。许可与来源说明位于 `src/vendor/deepseek-account/LICENSE` 和 `src/vendor/deepseek-account/NOTICE.md`，随程序保留。

## 其他依赖

应用的 npm 依赖及精确版本见 `package.json` 与 `package-lock.json`。安装后各依赖目录内保留其许可文件。Windows 便携构建复制 Electron 运行时随附的 `LICENSE`、`LICENSES.chromium.html` 及运行依赖的许可文件。

本说明不改变各第三方组件的许可证，也不将它们重新许可为 MIT 或其他许可证。
