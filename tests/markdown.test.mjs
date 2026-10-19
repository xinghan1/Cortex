import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/markdown.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(source, context);
const api = context.ForgeMarkdown;
const parse = text => JSON.parse(JSON.stringify(api.parseMarkdown(text)));
const inline = text => JSON.parse(JSON.stringify(api.parseInline(text)));
const flatten = tokens => tokens.map(token => token.value ?? flatten(token.children || [])).join('');

test('Chinese bold and Windows paths render as strong without altering backslashes', () => {
  const blocks = parse('你好！已经创建好了：**E:\\其他项目\\pelican-cycle.html**\n\n- **鹈鹕骑行动画**：踏板、车轮旋转。\n- **验证结果**：检查通过。');
  assert.equal(blocks[0].type, 'paragraph');
  assert.deepEqual(blocks[0].children[1], { type: 'strong', children: [{ type: 'text', value: 'E:\\其他项目\\pelican-cycle.html' }] });
  assert.equal(blocks[1].type, 'list');
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[1].items[0][0].children[0].type, 'strong');
  assert.equal(flatten(inline('**1**')), '1');
});

test('inline formatting supports emphasis, deletion, nested strong and literal underscores in paths', () => {
  const tokens = inline('**粗体与 *斜体***、~~删除~~、_斜体_、some_file_name.txt、***两者***');
  assert.equal(tokens[0].type, 'strong');
  assert.equal(tokens[0].children[1].type, 'em');
  assert.ok(tokens.some(token => token.type === 'del'));
  assert.ok(tokens.some(token => token.type === 'em'));
  assert.match(flatten(tokens), /some_file_name\.txt/u);
  assert.equal(tokens.at(-1).children[0].type, 'em');
});

test('escaped punctuation remains literal and does not consume Windows path characters', () => {
  const tokens = inline('\\*不是斜体\\* \\**不是粗体\\** C:\\new_folder\\data.json \\[链接\\]');
  assert.equal(flatten(tokens), '*不是斜体* **不是粗体** C:\\new_folder\\data.json [链接]');
  assert.equal(tokens.filter(token => token.type !== 'text').length, 0);
});

test('inline code preserves HTML, whitespace and Markdown verbatim', () => {
  const tokens = inline('` **原样** <img src=x onerror=bad()> ` 与 ``a`b``');
  assert.equal(tokens[0].type, 'code');
  assert.equal(tokens[0].value, ' **原样** <img src=x onerror=bad()> ');
  assert.equal(tokens[2].value, 'a`b');
});

test('fenced code preserves CRLF and contents, accepts longer closing fences and unclosed streams', () => {
  const blocks = parse('````html\r\n<script>bad()</script>\r\n```\r\n````\r\n尾部');
  assert.deepEqual(blocks[0], { type: 'fence', language: 'html', value: '<script>bad()</script>\r\n```\r\n' });
  assert.equal(blocks[1].children[0].value, '尾部');
  assert.deepEqual(parse('~~~js\nconst text = "**";'), [{ type: 'fence', language: 'js', value: 'const text = "**";' }]);
});

test('headings, paragraphs, block quotes, ordered lists, nested lists and rules are semantic blocks', () => {
  const blocks = parse('# 一级\n\n## 二级 ##\n\n> 引用 **文字**\n>\n> - 引用列表\n\n3. 三\n4. 四\n   - 子项\n\n---\n\n两行\n保留换行');
  assert.deepEqual(blocks.slice(0, 2).map(block => [block.type, block.level, flatten(block.children)]), [['heading', 1, '一级'], ['heading', 2, '二级']]);
  assert.equal(blocks[2].type, 'quote');
  assert.equal(blocks[2].children[1].type, 'list');
  assert.equal(blocks[3].type, 'list');
  assert.equal(blocks[3].start, 3);
  assert.equal(blocks[3].items[1][1].type, 'list');
  assert.equal(blocks[4].type, 'rule');
  assert.equal(flatten(blocks[5].children), '两行\n保留换行');
});

test('tables preserve escaped pipes and pipes in inline code, with column alignment', () => {
  const table = parse('| **名称** | 参数 | 备注 |\n| :--- | :---: | ---: |\n| 中文 | `a|b` | x\\|y |\n| 空行 | | 3 |')[0];
  assert.equal(table.type, 'table');
  assert.deepEqual(table.align, ['left', 'center', 'right']);
  assert.equal(table.headers[0][0].type, 'strong');
  assert.equal(table.rows[0][1][0].value, 'a|b');
  assert.equal(flatten(table.rows[0][2]), 'x|y');
  assert.deepEqual(table.rows[1][1], []);
});

test('only absolute HTTP(S) URLs are eligible for browser links', () => {
  for (const value of ['https://example.com/a?q=1#part', 'http://localhost:5173/中文', 'https://127.0.0.1:9443/']) assert.ok(api.safeMarkdownUrl(value), value);
  for (const value of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hello', 'file:///C:/secret', '//example.com', 'https://a.com/\nnext', 'https:\\evil.com', 'https://user:password@a.com/', ' https://example.com', 'https://example.com/a b']) assert.equal(api.safeMarkdownUrl(value), null, value);
});

test('links support labels and balanced parentheses; unsafe links and images remain source text', () => {
  const tokens = inline('[**文档**](https://example.com/a_(b)) <http://localhost:5173/>');
  assert.equal(tokens[0].type, 'link');
  assert.equal(tokens[0].href, 'https://example.com/a_(b)');
  assert.equal(tokens[0].children[0].type, 'strong');
  assert.equal(tokens[2].type, 'link');
  const unsafe = '[危险](javascript:alert(1)) ![照片](https://example.com/private.png)';
  assert.equal(flatten(inline(unsafe)), unsafe);
  assert.equal(inline(unsafe).some(token => token.type === 'link'), false);
});

test('HTML is plain text and code is never parsed as Markdown or a link', () => {
  const html = '<script>globalThis.compromised=true</script><img src="https://example.com/track" onerror="bad()">';
  assert.equal(flatten(parse(html)[0].children), html);
  const blocks = parse('```html\n' + html + '\n[link](https://example.com)\n**粗体**\n```');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].value, html + '\n[link](https://example.com)\n**粗体**\n');
  assert.doesNotMatch(source, /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/u);
});

test('streaming incomplete syntax stays readable and becomes formatting when completed', () => {
  assert.equal(flatten(parse('**还在输出')[0].children), '**还在输出');
  assert.equal(parse('**还在输出**')[0].children[0].type, 'strong');
  assert.equal(flatten(parse('[链接](https://exa')[0].children), '[链接](https://exa');
  assert.equal(parse('[链接](https://example.com)')[0].children[0].type, 'link');
});

test('empty input and punctuation-heavy or deeply nested input do not fail', () => {
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse('\n\r\n'), []);
  assert.ok(parse('['.repeat(30_000)).length);
  assert.ok(parse('> '.repeat(50) + '**过深仍为文字**').length);
  assert.equal(flatten(inline('2 * 3 * 4 = 24')), '2 * 3 * 4 = 24');
});
