import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {mobileFiles} = createRequire(import.meta.url)('../src/core/mobile-files.cjs');

test('remote file reading and optimistic edits preserve external changes', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cortex-mobile-files-'));
  try {
    const target=path.join(root,'example.txt'); await fs.writeFile(target,'原始内容');
    const list=await mobileFiles('list',{path:root}); assert.ok(list.entries.some(e=>e.path===target));
    const read=await mobileFiles('read',{path:target}); assert.equal(read.content,'原始内容');
    await fs.writeFile(target,'电脑端更新');
    await assert.rejects(mobileFiles('write',{path:target,content:'手机更新',version:read.version}), e=>e.status===409);
    assert.equal(await fs.readFile(target,'utf8'),'电脑端更新');
    const next=await mobileFiles('read',{path:target}); const saved=await mobileFiles('write',{path:target,content:'手机更新',version:next.version});
    assert.equal(saved.saved,true); assert.equal(await fs.readFile(target,'utf8'),'手机更新');
    await assert.rejects(mobileFiles('write',{path:target,content:'x'}), e=>e.status===400);
    const project=path.join(root,'project'); let opened;
    await mobileFiles('project',{path:project},async p=>{opened=p}); assert.equal(opened,project);
    const downloaded=await mobileFiles('download',{path:target}); try {assert.equal(downloaded.size,Buffer.byteLength('手机更新'));} finally {await downloaded.handle.close();}
    await assert.rejects(mobileFiles('read',{path:'relative'}), e=>e.status===400);
    await fs.writeFile(target, Buffer.from([0,1,2])); await assert.rejects(mobileFiles('read',{path:target}), e=>e.status===415);
    await fs.writeFile(target,Buffer.alloc(2*1024*1024+1,65)); await assert.rejects(mobileFiles('read',{path:target}), e=>e.status===413);
    if(process.platform==='win32') {
      await assert.rejects(mobileFiles('read',{path:'\\\\.\\pipe\\cortex'}), e=>e.status===400);
      await assert.rejects(mobileFiles('read',{path:path.join(root,'NUL')}), e=>e.status===400);
    }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
