// Tests the shipped renderer in an isolated Electron window; no links are opened.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function smokeMarkdown({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Markdown smoke requires an isolated offscreen window');
  const js = code => win.webContents.executeJavaScript(code);
  const windowsPath = 'E:\\其他项目\\pelican-cycle.html';
  const code = '<script>globalThis.__markdownExecuted=true</script>\r\nconst literal = "**原样**";\r\n';
  const fixture = '# Markdown 格式预览\n\n你好！已经创建好了：**' + windowsPath + '**\n\n- **鹈鹕骑行动画**：踏板、车轮旋转、身体起伏。\n- **验证结果**：SVG XML 结构和 JavaScript 语法检查通过。\n\n> 支持 *斜体*、~~删除线~~ 和 `行内代码`。\n\n| 名称 | 状态 |\n| :--- | ---: |\n| 中文格式 | **通过** |\n| 图片标签 | 保留原文 |\n\n```html\r\n' + code + '```\n\n<script>globalThis.__markdownExecuted=true</script>\n![图片](https://example.invalid/do-not-load.png)\n[危险链接](javascript:alert(1))';
  let installed = false;
  try {
    const initial = await js(`(() => {
      if (!window.ForgeMarkdown) throw new Error('Markdown script was not loaded before app.js');
      const scroll = document.getElementById('message-scroll') || document.querySelector('.message-scroll');
      const messages = document.getElementById('messages'), welcome = document.getElementById('welcome');
      window.__markdownSmoke = { scroll, scrollTop: scroll?.scrollTop, followOutput, messagesHidden: messages.hidden, welcome, welcomeHidden: welcome?.hidden };
      followOutput = false;
      const rendered = addMessage('assistant', ${JSON.stringify(fixture)});
      window.__markdownSmoke.message = rendered.message;
      const body = rendered.body;
      const anchorHost = document.createElement('div');
      let clicked = null;
      ForgeMarkdown.renderMarkdown(anchorHost, '[**安全链接**](http://127.0.0.1:4321/a_(b))', { onLink: value => { clicked = value; } });
      const anchor = anchorHost.querySelector('a');
      const cancelled = !anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const streaming = document.createElement('div');
      renderText(streaming, '**流式文字');
      const partial = streaming.textContent;
      renderText(streaming, '**流式文字**');
      const completed = streaming.querySelector('strong')?.textContent;
      scroll.scrollTop += rendered.message.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      followOutput = false;
      const strong = body.querySelector('strong');
      return {
        hasClass: body.classList.contains('markdown-body'),
        heading: body.querySelector('h1')?.textContent,
        path: strong?.textContent, weight: Number(getComputedStyle(strong).fontWeight),
        list: [...body.querySelectorAll('ul>li>p>strong')].map(node => node.textContent),
        quote: !!body.querySelector('blockquote em') && !!body.querySelector('blockquote del'),
        code: body.querySelector('.message-code pre code')?.textContent,
        table: { head: body.querySelectorAll('thead th').length, rows: body.querySelectorAll('tbody tr').length, right: body.querySelector('th.markdown-align-right')?.textContent },
        dangerousElements: body.querySelectorAll('script,img,iframe,object,embed,svg,form,input').length,
        unsafeLinks: body.querySelectorAll('a').length,
        literalHtml: body.textContent.includes('<script>globalThis.__markdownExecuted=true</script>'),
        literalImage: body.textContent.includes('![图片](https://example.invalid/do-not-load.png)'),
        executed: globalThis.__markdownExecuted === true,
        link: { cancelled, clicked, rel: anchor.rel, text: anchor.querySelector('strong')?.textContent },
        streaming: { partial, completed }
      };
    })()`);
    installed = true;
    assert.equal(initial.hasClass, true);
    assert.equal(initial.heading, 'Markdown 格式预览');
    assert.equal(initial.path, windowsPath);
    assert.ok(initial.weight >= 600, 'Bold text must have visible styling');
    assert.deepEqual(initial.list, ['鹈鹕骑行动画', '验证结果']);
    assert.equal(initial.quote, true);
    assert.equal(initial.code, code, 'Fenced code must retain exact source text and CRLF');
    assert.deepEqual(initial.table, { head: 2, rows: 2, right: '状态' });
    assert.equal(initial.dangerousElements, 0);
    assert.equal(initial.unsafeLinks, 0);
    assert.equal(initial.literalHtml, true);
    assert.equal(initial.literalImage, true);
    assert.equal(initial.executed, false);
    assert.deepEqual(initial.link, { cancelled: true, clicked: 'http://127.0.0.1:4321/a_(b)', rel: 'noopener noreferrer', text: '安全链接' });
    assert.deepEqual(initial.streaming, { partial: '**流式文字', completed: '流式文字' });
    // Offscreen capture may otherwise reuse the previous composited frame even
    // though every DOM assertion already observes the new Markdown message.
    await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      const saved = window.__markdownSmoke;
      saved.scroll.scrollTop += saved.message.getBoundingClientRect().top - saved.scroll.getBoundingClientRect().top;
      followOutput = false;
      resolve(true);
    })))`);
    win.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 110));
    const visible = await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      const saved = window.__markdownSmoke;
      const viewport = saved.scroll.getBoundingClientRect();
      const heading = saved.message.querySelector('h1').getBoundingClientRect();
      const list = saved.message.querySelector('ul').getBoundingClientRect();
      followOutput = false;
      resolve({
        heading: heading.top >= viewport.top - 1 && heading.bottom <= viewport.bottom + 1 && heading.left >= viewport.left && heading.right <= viewport.right,
        list: list.top >= viewport.top - 1 && list.bottom <= viewport.bottom + 1,
        headingText: saved.message.querySelector('h1').textContent
      });
    })))`);
    assert.equal(visible.headingText, 'Markdown 格式预览');
    assert.equal(visible.heading, true, 'Markdown heading must be visible in the screenshot viewport');
    assert.equal(visible.list, true, 'Markdown list must be visible in the screenshot viewport');
    await fs.writeFile(path.join(output, 'markdown-rendering.png'), (await win.webContents.capturePage()).toPNG());
    return { status: 'completed', boldWindowsPath: true, lists: 2, tableRows: 2, codeSourcePreserved: true, blockedHtmlAndImages: true, controlledLinkClicks: true, streaming: true };
  } finally {
    if (!win.isDestroyed()) await js(`(async () => {
      const saved = window.__markdownSmoke;
      if (!saved) return;
      saved.message?.remove();
      document.getElementById('messages').hidden = saved.messagesHidden;
      if (saved.welcome) saved.welcome.hidden = saved.welcomeHidden;
      if (saved.scroll) saved.scroll.scrollTop = saved.scrollTop;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      followOutput = saved.followOutput;
      delete window.__markdownSmoke;
      delete globalThis.__markdownExecuted;
    })()`).catch(error => { if (installed) throw error; });
  }
};
