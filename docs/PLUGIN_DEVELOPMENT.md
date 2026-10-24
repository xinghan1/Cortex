# Synora code 插件开发

插件是一个包含 `synora-plugin.json` 和本地 HTML / JavaScript / CSS 的目录。无需 Node.js 依赖，适合项目检查器、文本转换器、文档工具和自定义开发面板。

在软件顶部选择“设置 → 插件管理…”，点击“创建示例插件”，选择保存位置。编辑生成的 `hello-plugin` 目录后，使用“安装本地插件”选择这个目录，再点击“启用”和“打开”。安装会复制文件；修改源目录后，需移除已安装副本并重新安装。关闭软件后，安装记录与启用状态会保留，插件窗口由用户重新打开。

开发资料目录包含本说明、`sdk/plugin-api.d.ts` 类型和 `examples/hello-plugin` 示例；源代码仓库也包含这三项。示例支持查看软件版本、列出项目文件、读取文本、创建或修改文本文件，并在每次写入前交由软件确认。打开示例不会自动修改项目。

## 清单

```json
{
  "schemaVersion": 1,
  "id": "demo.hello",
  "name": "Hello 开发面板",
  "version": "1.0.0",
  "description": "查看项目文件，并体验带冲突检查的文本编辑。",
  "entry": "index.html",
  "permissions": ["project.read", "project.write", "notifications"],
  "commands": [{ "id": "hello.show", "title": "打开 Hello 开发面板" }]
}
```

`id` 使用小写字母、数字以及 `.` / `-`，以字母开头；发布后保持不变。`entry` 必须是插件目录内的 HTML 相对路径。命令最多 30 项，每个命令 ID 在本插件内唯一。软件将命令显示为可点击入口，并把对应 ID 发送给插件。

只申请需要的权限：`project.read` 允许列目录、读取当前项目文本；`project.write` 允许请求写入项目文本，每次写入仍由软件确认；`notifications` 允许在软件中显示简短通知。版本信息和当前项目名称不需要额外权限。

## JavaScript API

插件页面使用 `window.synoraPlugin`。HTML 内通过外部脚本加载代码，例如 `<script src="main.js" defer></script>`；不要使用内联脚本、`eval` 或动态生成代码。

```javascript
const api = window.synoraPlugin;
const app = await api.info();
const project = await api.project.info();
const files = await api.project.listFiles({ path: "src" });
const before = await api.project.readText({ path: "README.md" });

// 在用户点击保存后调用，软件会显示确认窗口。
const after = await api.project.writeText({
  path: before.path,
  content: before.content + "\n插件示例\n",
  expectedVersion: before.version
});

await api.notify("处理完成");
const unsubscribe = api.onCommand(({ id }) => {
  if (id === "hello.show") document.getElementById("title").focus();
});
```

`readText` / `writeText` 返回 `{ path, content, version }`。更新现有文件时，必须原样传回读取到的 `version`；创建新文件传 `expectedVersion: null`。目标已被编辑、正在编辑器中未保存、项目切换或确认期间插件已关闭时，写入会被拒绝，请重新读取再让用户操作。文件路径始终相对于打开插件时的项目，不能使用绝对路径或 `..`。文本最多 512 KiB，目录列表最多 500 项。当前未打开项目时，项目 API 会返回错误。

所有异步 API 可能拒绝 Promise，应捕获错误并通过 `textContent` 显示。不要将读取到的项目文本当作 HTML 插入页面。`onCommand` 返回取消订阅函数；窗口销毁后，所有插件请求与页面代码停止。

## 运行与分发

插件运行在独立、沙箱化的窗口中，不直接访问主聊天窗口、模型账号或 API Key，也不提供 `require`、`process`、终端、任意文件系统或网络 API。页面资源必须来自自己的安装目录；网络连接、弹窗、下载、嵌入网页和权限申请均被阻止。需要依赖时，把浏览器版本的 JavaScript / CSS 一起打包进插件目录，不要附带 `node_modules`。目录内不能有符号链接或硬链接。

安装包最多 1000 个文件与目录、总计 20 MB，单文件最多 4 MB。插件使用外部 `.js` / `.css` 和本地图片、字体。软件卸载插件只删除其托管副本，不删除开发者的源目录。停用插件会立即关闭其全部窗口；关闭所属的软件窗口也会关闭插件窗口。

这是第 1 版扩展 API。插件目前通过独立开发面板和声明式命令扩展软件，不向主界面注入脚本或替换核心模型流程。类型定义见 `sdk/plugin-api.d.ts`。
