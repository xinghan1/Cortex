# 豆包 / 火山方舟接入依据

核对日期：2026-10-26。所有推理协议测试使用本地模拟响应，未使用真实密钥或付费推理。

## API Key

默认地址为 `https://ark.cn-beijing.volces.com/api/v3`，使用 Bearer API Key 和 Chat Completions。官方模型 ID 与用户推理接入点 ID 均原样发送；不根据名字猜测 API 路由。专用套餐地址为 `/api/plan/v3` 或 `/api/coding/v3`，由账号配置或用户明确提供。

依据：[Base URL 及鉴权](https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh)、[Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)。

## 模型与推理档位

没有查到使用普通 Ark API Key 读取 OpenAI 风格 `GET /models` 的官方说明，因此官方地址返回明确标注 `source: official-docs` 的公开文档快照，而非伪造已授权目录。快照仅列 Seed 2.1 Pro/Lite 260915 与 Turbo 260628；实际开通权限由方舟决定，自定义接入点 ID 仍可原样请求。

公开目录记录文本、图片与工具能力；这些精确型号的原生推理档位为 `minimal`、`low`、`medium`、`high`，默认 `high`。兼容映射别名不作为新增原生档位。未知型号和自定义网关不继承这些假设。

依据：[模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=zh)、[模型参数支持](https://docs.volcengine.com/docs/ark/model-parameter-support?lang=zh)、[深度思考](https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh)。

Chat 响应的 `reasoning_content` 与 `encrypted_content` 均在原生消息内保留，后续工具回合原样回传。密文绑定服务商、型号、地址、协议与连接身份；不会传给其他连接。取消、截断、无效工具 JSON 和密钥回显均拒绝产生可执行结果。

## 火山方舟账号

官方提供 `@volcengine/ark-cli`、`arkcli auth login` 和 `arkcli auth status`，可登录火山账号并选择 Agent Plan / Coding Plan。SSO 管理面登录与模型数据面 API Key 是不同凭据。账号控制器应只调用官方 CLI 的授权、状态、资源和受控 API Key 导出接口，再用操作系统密钥存储保存，不抓网页 Cookie 或读取 SSO token。

依据：[Ark CLI Agent Plan 使用指南](https://docs.volcengine.com/docs/ark/agent-plan-personal-ark-cli?lang=zh)、[Ark CLI 登录与运行时凭据说明](https://docs.volcengine.com/docs/ark/build-investment-research-agent-with-arkcli?lang=zh)。

主设置分别保存 API Key / `ark-account` 型号槽；旧 Claude API 配置迁移为 API Key / `claude-agent` 独立型号槽，保留加密密钥。独立角色当前支持豆包 API Key，拒绝完整官方代理与 Ark 账号模式，避免借用主账号或混用凭据。
