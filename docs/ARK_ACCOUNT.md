# 火山方舟账号连接

`src/core/ark-account.mjs` 使用官方 `@volcengine/ark-cli@1.0.42` 完成火山方舟账号授权，再将所选 Profile 的运行时凭证交给 Synora 的豆包 API 适配器。此连接适用于方舟、Agent Plan 和 Coding Plan。

## 授权与 Profile 选择

控制器在每次登录专用的 `HOME` / `USERPROFILE` 中运行原始 CLI：

```text
arkcli auth login volc-sso
arkcli auth status --format json
arkcli auth whoami --format json
```

Profile 候选来自本次返回的 `profiles_summary` 与 `active_profile`。无参 `signIn()` 在 `attempt.phase=choosing-profile` 等待；`selectProfile(profileName)` 只能选择该列表中的名称，并继续原登录任务。即使只有一个候选，也需要用户明确选择。取消授权会中止等待并清理尚未绑定的隔离目录。

选定后，控制器通过带 `--profile <name>` 的 `auth status` / `auth whoami` 再次核对名称、类型、区域、项目和本次登录主体，再执行：

```text
arkcli profile apikey get --profile <name> --plain
arkcli resources list --profile <name> --modality text --format json
```

只有完整运行时 Key 和同一 Profile 下兼容的文本资源均已取得，才发布 `connected`。Plan 缺少权限、席位、Key 或资源时直接失败；控制器不会选择其它 Profile，也不会回退到按量计费入口。官方登录可能自动派生 Profile；控制器不额外调用 `profile create/use`，不购买套餐、不创建或轮换 Key。

## 路由与资源边界

当前仅支持 `cn-beijing`。基础主机为 `https://ark.cn-beijing.volces.com`；文本资源严格校验官方 `data_plane`、`credential_kind`、`invocable` 和 `required_overrides`。

| Profile 类型 | API 路径 | data_plane | credential_kind | 资源 |
|---|---|---|---|---|
| platform | /api/v3 | platform | paygo | Endpoint |
| agent-plan | /api/plan/v3 | agent_plan | agent_plan | 模型 |
| coding-plan | /api/coding/v3 | coding_plan | paygo | 模型 |
| agent-plan-team | /api/plan/v3 | agent_plan | team_seat | 模型 |
| coding-plan-team | /api/coding/v3 | coding_plan | team_seat | 模型 |

Coding Plan 个人版文本入口使用普通后付费 API Key，套餐路径仍为 `/api/coding/v3`；不能因此改走 `/api/v3`。团队席位 Key 也不能替代平台 Key。当前 CLI 资源列表的公开契约不包含推理档位菜单，控制器不会按模型名推断推理强度或扩张能力声明。

## 凭证与会话隔离

Synora 不读取 CLI 的凭证文件，不提取 Cookie、SSO Token 或调用非公开认证接口。官方导出命令的 stdout 只在主进程内处理。Key、Profile 主体和绑定资料经 Electron `safeStorage` 整体加密、原子保存，并在写入后解密回读校验；安全存储不可用时没有明文回退。CLI 自己的认证资料由官方进程保存在应用隔离目录中。

Renderer 只接收 Profile 摘要、连接状态和资源目录。每次成功连接产生新的会话身份，绑定内容包含 Profile 类型、主体、区域、项目及 Key 摘要。账号切换或断连会中止进行中的请求；旧 `arkProfileId` 不能用于新连接。401 要求重新连接，失败或取消的新授权保留原有有效连接。

## 源码构建与验证

npm 包内的 `scripts/run.js` 是原生二进制启动器。若依赖安装使用了 `--ignore-scripts`，构建前须准备官方二进制；在 `CI=1` 环境运行官方安装脚本，避免附带安装其它 Agent 的 Skills：

```powershell
$env:CI = '1'
node node_modules/@volcengine/ark-cli/scripts/postinstall.js
```

官方脚本按随包 `manifest.json` 下载并校验 SHA-256。仓库构建流程通过 `scripts/prepare-accounts.mjs` 检查账号组件。控制器直接定位该包的 `bin/arkcli-<platform>-<arch>`，再次验证哈希；不会从 `PATH` 选择任意同名程序。Windows 安装包需保留 `electron-builder.json` 中的 `asarUnpack` 原生二进制规则。缺少二进制或校验失败时，`ensure()` 明确报错。

`node --test tests/ark-account.test.mjs` 使用假 CLI 和测试加密器验证授权、Profile 范围、取消、回滚与调用隔离，不登录真实账号或发送推理请求。

官方依据：[认证与 Profile 摘要](https://github.com/volcengine/ark-cli/blob/main/skills/arkcli-auth/SKILL.md)、[运行时 Key 导出](https://github.com/volcengine/ark-cli/blob/main/skills/arkcli-auth/references/api-key-query.md)、[资源列表契约](https://github.com/volcengine/ark-cli/blob/main/skills/arkcli-resources/references/arkcli-resources-list.md)、[数据面与凭证矩阵](https://github.com/volcengine/ark-cli/blob/main/skills/arkcli-shared/references/execution-context.md)。
