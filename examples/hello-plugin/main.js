'use strict';
const api = window.synoraPlugin;
const byId = id => document.getElementById(id);
let loadedPath = null, loadedVersion = null, busy = false;
const status = value => { byId('status').textContent = value; };
function controls() {
  for (const id of ['list', 'read', 'new', 'notify']) byId(id).disabled = busy;
  byId('path').disabled = busy; byId('content').readOnly = busy;
  byId('save').disabled = busy || loadedPath === null || loadedPath !== byId('path').value.trim();
}
async function action(callback) {
  if (busy) return;
  busy = true; controls();
  try { await callback(); } catch (error) { status(error?.message || '操作失败，请重试。'); }
  finally { busy = false; controls(); }
}
async function read() {
  const result = await api.project.readText({ path: byId('path').value.trim() });
  loadedPath = result.path; loadedVersion = result.version; byId('path').value = result.path; byId('content').value = result.content;
  status('已读取 ' + result.path + '，可以修改后请求保存。');
}
byId('path').addEventListener('input', controls);
byId('read').addEventListener('click', () => action(read));
byId('new').addEventListener('click', () => {
  loadedPath = 'synora-plugin-example.txt'; loadedVersion = null; byId('path').value = loadedPath;
  byId('content').value = 'Hello from Synora code plugin!\n'; status('已准备新文件内容。点击“请求保存”后由软件确认，现有同名文件不会被覆盖。'); controls();
});
byId('save').addEventListener('click', () => action(async () => {
  if (loadedPath !== byId('path').value.trim()) throw new Error('文件路径已变化，请先重新读取。');
  const result = await api.project.writeText({ path: loadedPath, content: byId('content').value, expectedVersion: loadedVersion });
  loadedPath = result.path; loadedVersion = result.version; byId('content').value = result.content; status('已保存 ' + result.path);
}));
byId('notify').addEventListener('click', () => action(async () => { await api.notify('Hello 插件已连接。'); status('通知已发送。'); }));
byId('list').addEventListener('click', () => action(async () => {
  const project = await api.project.info(); byId('project-info').textContent = project.name + ' · ' + project.root;
  const files = await api.project.listFiles(); byId('files').replaceChildren();
  for (const file of files) {
    const button = document.createElement('button'); button.textContent = (file.type === 'directory' ? '📁 ' : '') + file.path;
    button.disabled = file.type === 'directory';
    button.addEventListener('click', () => action(async () => { byId('path').value = file.path; await read(); }));
    byId('files').append(button);
  }
  status('列出 ' + files.length + ' 个项目。');
}));
api.onCommand(({ id }) => { status('已打开命令：' + id); byId('title').focus(); });
api.info().then(info => { byId('app-info').textContent = info.name + ' ' + info.version + ' · 插件 API ' + info.apiVersion; })
  .catch(error => status(error?.message || '无法连接软件。'));
controls();
