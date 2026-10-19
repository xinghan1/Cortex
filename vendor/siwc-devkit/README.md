# Synora code 使用的本机登录 SDK 源码

此目录是 [OpenAI Sign-in with ChatGPT DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit) 的本机组件子集，来自提交 `0a36fefeb913055c8c7a1a29b63d82b96b2e841a`。未包含 React 界面、示例应用、品牌资源或上游 Git 元数据。

保留内容包括 `packages/local/src/`、相应测试、TypeScript 配置、包元数据、许可证和第三方声明。`index.ts` 与 `types.ts` 的本项目修改在文件顶部标明，按原 SDK 非商业许可证分发。

请从 **Synora code 仓库根目录**运行：

```powershell
npm.cmd ci
npm.cmd run prepare:sdk
```

根目录的构建脚本直接使用根目录安装的 TypeScript 和依赖，生成 `src/vendor/siwc/`。此子集不提供上游完整工作区，不能在本目录运行上游完整构建命令。

许可证见 [LICENSE](LICENSE)；第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
