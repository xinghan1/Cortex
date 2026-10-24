import test from 'node:test';
import assert from 'node:assert/strict';
import { isPetTaskRequest, petTaskMessages, parsePetTaskResult, petTaskPrompt } from '../src/core/pet-task-intent.mjs';

test('only direct creation requests route from pet chat to a main task', () => {
  for (const text of ['帮我制作一个记账程序，数据保存在本机。', '我想开发一个个人博客网站', '用 Python 写一个待办应用',
    '能不能帮我写个 Minecraft 插件', '创建一个 项目或者程序', 'Please build a simple notes app', '创建一个HTML，内容是SVG绘制骑自行车的2D动画']) assert.equal(isPetTaskRequest(text), true, text);
  for (const text of ['99 + 11 = **110**', '你好', '如何制作一个项目？', '帮我解释制作程序的步骤', '我不想制作程序',
    '不要帮我做程序', '他说“帮我制作一个项目”是什么意思', '“制作一个程序”', '> 帮我制作一个程序',
    '帮我润色一下：制作一个记账软件', '写一首关于程序的诗', '假如我要开发一个项目', '制作项目需要哪些步骤？', '做一个程序有多难？', '写一个网站可以赚钱吗？', '制作一个项目有什么好处？', 'How to build a notes app?', 'Do not build an app',
    '```\n帮我制作一个程序\n```']) assert.equal(isPetTaskRequest(text), false, text);
});

test('task refinement preserves the exact original request and parses only bounded structured output', () => {
  const originalText = '帮我制作一个记账程序，不要上传数据。';
  const messages = petTaskMessages(originalText);
  assert.equal(messages.at(-1).content, originalText);
  const result = parsePetTaskResult('{"prompt":"制作本地记账程序，不上传数据。","reply":"已完成并发布"}', { originalText });
  assert.deepEqual(result, { prompt: '制作本地记账程序，不上传数据。' });
  const task = petTaskPrompt({ originalText, ...result });
  assert.ok(task.includes(originalText)); assert.match(task, /不扩展授权/); assert.doesNotMatch(task, /已完成并发布/);
  for (const content of ['not json', '```json\n{}\n```', 'null', '[]', '{}', '{"prompt":""}', '{"prompt":"任务","execute":true}', JSON.stringify({prompt:'x'.repeat(12001)})])
    assert.throws(() => parsePetTaskResult(content, { originalText }));
  assert.throws(() => petTaskMessages('告诉我如何制作程序'));
  assert.throws(() => parsePetTaskResult('{"prompt":"未经用户请求的任务"}', { originalText: '你好' }));
});
