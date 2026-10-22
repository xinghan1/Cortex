import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { readXmlURL, isXmlURL, MAX_XML_BYTES } = createRequire(import.meta.url)('../src/core/xml-reader.cjs');
const url = 'https://example.test/maven-metadata.xml';
const xml = '<?xml version="1.0"?><metadata><version>26.3</version></metadata>';
const response = (text = xml, headers = {}) => new Response(text, { headers: { 'content-type': 'application/xml; charset=utf-8', ...headers } });

test('XML URLs use their pathname and unsafe schemes/credentials never reach fetch', async () => {
  assert.equal(isXmlURL(url + '?v=1#fragment'), true);
  assert.equal(isXmlURL('https://example.test/not.xml.html'), false);
  for (const invalid of ['file:///secret.xml', 'data:text/xml,secret', 'https://name:password@example.test/a.xml']) {
    await assert.rejects(readXmlURL({ url: invalid }, { fetchImpl: () => assert.fail('Unsafe URL fetched') }));
  }
});

test('XML is returned as source without a browser, cookies, credentials or entity evaluation', async () => {
  const source = '<!DOCTYPE x [<!ENTITY remote SYSTEM "https://private.test/entity">]><x>&remote;<script>never()</script></x>';
  const calls = [];
  const value = await readXmlURL({ url }, { fetchImpl: async (target, options) => { calls.push({ target, options }); return response(source); } });
  assert.equal(value.content, source); assert.equal(value.format, 'xml'); assert.equal(value.browserOpened, false);
  assert.equal(value.truncated, false); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual'); assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.headers.Authorization, undefined); assert.equal(calls[0].options.headers.Cookie, undefined);
});

test('long XML has an exact bounded source window and an explicit continuation offset', async () => {
  const fetchImpl = async () => response();
  const first = await readXmlURL({ url, limit: 20 }, { fetchImpl });
  const second = await readXmlURL({ url, offset: first.nextOffset, limit: 50000 }, { fetchImpl });
  assert.equal(first.content + second.content, xml); assert.equal(first.truncated, true);
  assert.equal(second.truncated, false); assert.equal(second.nextOffset, null); assert.equal(second.totalCharacters, xml.length);
  await assert.rejects(readXmlURL({ url, offset: xml.length + 1 }, { fetchImpl }), /起点/);
  await assert.rejects(readXmlURL({ url, limit: 50001 }, { fetchImpl }), /范围/);
});

test('redirects are separately authorized and cannot change to file or credential-bearing URLs', async () => {
  const calls = [], approved = [];
  const value = await readXmlURL({ url }, { fetchImpl: async target => {
    calls.push(target); return calls.length === 1 ? new Response(null, { status: 302, headers: { location: '/next.xml' } }) : response();
  }, onRedirect: async target => { approved.push(target); } });
  assert.deepEqual(approved, ['https://example.test/next.xml']); assert.equal(value.url, approved[0]);
  for (const target of ['file:///secret.xml', 'https://u:p@example.test/next.xml']) {
    await assert.rejects(readXmlURL({ url }, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: target } }),
      onRedirect: () => assert.fail('Invalid redirect was approved') }));
  }
  await assert.rejects(readXmlURL({ url }, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/next.xml' } }) }), /重定向需要/);
});

test('denied redirects stop before fetching the new target', async () => {
  let calls = 0;
  const error = Object.assign(new Error('AI 拒绝此目标'), { code: 'APPROVAL_DENIED' });
  await assert.rejects(readXmlURL({ url }, { fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: '/denied.xml' } }); },
    onRedirect: async () => { throw error; } }), value => value === error);
  assert.equal(calls, 1);
});

test('HTTP failures, HTML and oversized XML remain explicit failures', async () => {
  await assert.rejects(readXmlURL({ url }, { fetchImpl: async () => new Response('failed', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(readXmlURL({ url }, { fetchImpl: async () => response('<html>login</html>', { 'content-type': 'text/html' }) }), /HTML/);
  await assert.rejects(readXmlURL({ url }, { fetchImpl: async () => response(xml, { 'content-length': String(MAX_XML_BYTES + 1) }) }), /超过/);
  await assert.rejects(readXmlURL({ url }, { fetchImpl: async () => response('<x>' + 'x'.repeat(MAX_XML_BYTES)) }), /超过/);
  await assert.rejects(readXmlURL({ url }, { fetchImpl: async () => response('plain text') }), /源文本/);
});

test('declared legacy and BOM-based XML encodings preserve the source text', async () => {
  const source = '<?xml version="1.0" encoding="iso-8859-1"?><x>caf\u00e9</x>';
  const latin = await readXmlURL({ url }, { fetchImpl: async () => new Response(Buffer.from(source, 'latin1'), { headers: { 'content-type': 'text/xml' } }) });
  assert.equal(latin.content, source);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<x>中文</x>', 'utf16le')]);
  const unicode = await readXmlURL({ url }, { fetchImpl: async () => new Response(utf16, { headers: { 'content-type': 'text/xml' } }) });
  assert.equal(unicode.content, '<x>中文</x>');
});

test('Stop and timeout cancel the HTTP operation rather than leaving an unbounded reader', async () => {
  const heldFetch = async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  const controller = new AbortController(), stopped = readXmlURL({ url }, { fetchImpl: heldFetch, signal: controller.signal });
  const reason = new Error('stopped'); controller.abort(reason);
  await assert.rejects(stopped, error => error === reason);
  await assert.rejects(readXmlURL({ url }, { fetchImpl: heldFetch, timeoutMs: 10 }), /超时/);
});
