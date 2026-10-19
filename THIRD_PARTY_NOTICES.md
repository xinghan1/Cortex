# 第三方组件说明

## OpenAI Sign-in with ChatGPT DevKit

来源：<https://github.com/openai/sign-in-with-chatgpt-devkit>

所用上游提交：`0a36fefeb913055c8c7a1a29b63d82b96b2e841a`。

本仓库在 `vendor/siwc-devkit/` 保留本机登录组件的源代码、测试、编译配置和许可文件。`npm run prepare:sdk` 生成的运行时代码位于 `src/vendor/siwc/`，并随构建复制许可证和第三方声明。

该组件采用 **SIGN-IN WITH CHATGPT DEVKIT NONCOMMERCIAL LICENSE, Version 1.0**，仅许可非商业用途。原文见 [SDK 许可证](vendor/siwc-devkit/LICENSE)，依赖声明见 [SDK 第三方声明](vendor/siwc-devkit/THIRD_PARTY_NOTICES.md)。此许可不授予 OpenAI 品牌、商标或服务访问权。

本项目修改了 `packages/local/src/index.ts` 和 `packages/local/src/types.ts`，增加仅在 Electron 主进程内使用的 `withAccessToken` 回调；两个文件均保留修改说明。对该 SDK 的修改按同一非商业许可证分发。OAuth 校验、权限检查、凭据轮换和取消流程仍使用原组件实现。Synora code 当前将此接入用于本机个人实验；商业使用该组件需要另行获得许可。

## 其他依赖

应用的 npm 依赖及精确版本见 `package.json` 与 `package-lock.json`。安装后各依赖目录内保留其许可文件。Windows 便携构建复制 Electron 运行时随附的 `LICENSE`、`LICENSES.chromium.html` 及运行依赖的许可文件。

本说明不改变各第三方组件的许可证，也不将它们重新许可为 MIT 或其他许可证。
