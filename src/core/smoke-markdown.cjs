// Tests the shipped renderer in an isolated Electron window; no links are opened.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { clipboard, ClipboardItem } = require('electron');

module.exports = async function smokeMarkdown({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Markdown smoke requires an isolated offscreen window');
  const js = code => win.webContents.executeJavaScript(code);
  const windowsPath = 'E:\\其他项目\\pelican-cycle.html';
  const code = '<script>globalThis.__markdownExecuted=true</script>\r\nconst literal = "**原样**";\r\n';
  const fixture = '# Markdown 格式预览\n\n你好！已经创建好了：**' + windowsPath + '**\n\n- **鹈鹕骑行动画**：踏板、车轮旋转、身体起伏。\n- **验证结果**：SVG XML 结构和 JavaScript 语法检查通过。\n\n> 支持 *斜体*、~~删除线~~ 和 `行内代码`。\n\n| 名称 | 状态 |\n| :--- | ---: |\n| 中文格式 | **通过** |\n| 图片标签 | 保留原文 |\n\n```html\r\n' + code + '```\n\n<script>globalThis.__markdownExecuted=true</script>\n![图片](https://example.invalid/do-not-load.png)\n[危险链接](javascript:alert(1))';
  let installed = false, originalAppearance, originalClipboard, clipboardReadbackAvailable = false;
  const originalClipboardWrite = clipboard.writeText, clipboardWrites = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Markdown smoke timed out: ' + label);
  };
  const copyBlock = async (host, index, expected) => {
    const point = await until('visible code copy button', () => js(`(() => {
      const button=window.__markdownSmoke[${JSON.stringify(host)}].querySelectorAll('.message-code-copy')[${index}];
      if(!button||button.disabled)return null;
      button.scrollIntoView({block:'center',behavior:'instant'});
      const box=button.getBoundingClientRect(),label=button.closest('.message-code-label').getBoundingClientRect();
      const point={x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};
      const visible=button.checkVisibility({visibilityProperty:true,opacityProperty:true});
      return visible&&box.width>0&&box.height>0&&button.contains(document.elementFromPoint(point.x,point.y))
        ? {...point,rightGap:label.right-box.right,topGap:box.top-label.top} : null;
    })()`));
    assert.ok(point.rightGap >= 0 && point.rightGap < 32 && point.topGap >= 0 && point.topGap < 16, 'Code copy button must sit at the header top right');
    win.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: point.x, y: point.y,
      ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    await until('code copied feedback', () => js(`(() => {
      const button=window.__markdownSmoke[${JSON.stringify(host)}].querySelectorAll('.message-code-copy')[${index}];
      return button.dataset.state==='copied'&&button.textContent==='已复制'&&!button.disabled;
    })()`));
    assert.equal(clipboardWrites.at(-1), expected, 'Native clipboard call included labels, feedback, fences or transformed code');
    if (clipboardReadbackAvailable) assert.equal(await clipboard.readText(), expected);
  };
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
    originalAppearance = await js('window.forge.getAppearance()');
    originalClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(
      await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
    clipboard.writeText = async function (...args) {
      clipboardWrites.push(args[0]);
      return await originalClipboardWrite.apply(this, args);
    };
    const seed = 'SYNORA_MARKDOWN_COPY_PROBE';
    await clipboard.writeText(seed);
    clipboardReadbackAvailable = await clipboard.readText() === seed;
    await copyBlock('message', 0, code);
    const secondCode = '  const greeting = "你好";\n\tconsole.log(greeting);\n';
    const plainCode = '**plain** & <literal>\r\n\r\n';
    const copyFixture = '```javascript\n' + secondCode + '```\n\n```\r\n' + plainCode + '```\r\n\r\n```text\n```\n\n普通行内 `code` 没有块复制按钮。';
    assert.deepEqual(await js(`(() => {
      const saved=window.__markdownSmoke;
      saved.copyMessage=addMessage('assistant',${JSON.stringify(copyFixture)}).message;
      const blocks=[...saved.copyMessage.querySelectorAll('.message-code')];
      return {count:blocks.length,buttons:saved.copyMessage.querySelectorAll('.message-code-copy').length,
        languages:blocks.map(block=>block.querySelector('.message-code-language').textContent),
        feedback:blocks.map(block=>{const status=block.querySelector('.message-code-copy-feedback');return [status.getAttribute('role'),status.getAttribute('aria-live')];})};
    })()`), { count: 3, buttons: 3, languages: ['javascript', '代码', 'text'], feedback: [['status','polite'],['status','polite'],['status','polite']] });
    await copyBlock('copyMessage', 0, secondCode);
    await copyBlock('copyMessage', 1, plainCode);
    await copyBlock('copyMessage', 2, '');
    for (const style of ['white', 'industrial']) {
      await js(`window.forge.setAppearance({uiStyle:${JSON.stringify(style)}})`);
      await js('window.synoraAppearance.settled()');
      await until('copy theme '+style, () => js(`document.documentElement.dataset.uiStyle===${JSON.stringify(style)}`));
      await copyBlock('copyMessage', 0, secondCode);
      win.webContents.invalidate(); await wait(120);
      await fs.writeFile(path.join(output, 'markdown-copy-' + style + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    return { status: 'completed', boldWindowsPath: true, lists: 2, tableRows: 2, codeSourcePreserved: true, blockedHtmlAndImages: true,
      controlledLinkClicks: true, streaming: true, nativeCopyButtons: true, exactCopiedCRLF: true, multipleAndEmptyBlocks: true,
      copyFeedback: true, copyThemes: ['white', 'industrial'], clipboardReadbackVerified: clipboardReadbackAvailable,
      clipboardCallVerified: true, copyOperations: clipboardWrites.length - 1 };
  } finally {
    clipboard.writeText = originalClipboardWrite;
    if (originalClipboard) {
      if (originalClipboard.length) await clipboard.write(originalClipboard);
      else await clipboard.clear();
    }
    if (originalAppearance && !win.isDestroyed()) {
      await js(`window.forge.setAppearance({uiStyle:${JSON.stringify(originalAppearance.uiStyle)}})`);
      await js('window.synoraAppearance.settled()');
    }
    if (!win.isDestroyed()) await js(`(async () => {
      const saved = window.__markdownSmoke;
      if (!saved) return;
      saved.message?.remove();
      saved.copyMessage?.remove();
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
