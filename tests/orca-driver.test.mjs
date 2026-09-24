// Repository names, attachment IDs and document names are synthetic offline fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const mint = new URL('../scripts/mint.sh', import.meta.url).pathname;
const page = '11111111-1111-4111-8111-111111111111';
const asset = '22222222-2222-4222-8222-222222222222';
// Run the real browser expression and paste library in a fresh VM for each eval.
// Browser/CLI boundaries are fake; the upload, polling and cleanup code are real.
const fixture = `#!/usr/bin/env node
const fs = require('node:fs'), vm = require('node:vm');
const args = process.argv.slice(2), page = '${page}', scenario=process.env.CASE;
const log = item => fs.appendFileSync(process.env.CALLS, JSON.stringify(item) + '\\n');
log({command:args.slice(0,2),page:args[args.indexOf('--page')+1]});
function reply(result) { console.log(JSON.stringify({id:'33333333-3333-4333-8333-333333333333',ok:true,result})); }
if (args[0] === 'tab' && args[1] === 'create') { reply({browserPageId:page}); process.exit(); }
if (args[args.indexOf('--page') + 1] !== page) { console.error('operation reached about:blank without its page'); process.exit(1); }
if (args[0] !== 'eval') { reply({}); process.exit(); }
if (scenario === 'malformed') { reply({result:'{}'}); process.exit(); }
const expression = args[args.indexOf('--expression')+1];
const evalCount=fs.readFileSync(process.env.CALLS,'utf8').trim().split('\\n').map(JSON.parse).filter(c=>c.command?.[0]==='eval').length;
const firstEval=evalCount===1;
const origin = scenario==='blank-mid-transfer' && evalCount===3 ? 'about:blank' : scenario==='query' ? 'https://github.com/owner/repo/issues/new?template=custom' : scenario==='blank-once' && firstEval ? 'about:blank' : scenario === 'wrong-repo' ? 'https://github.com/other/repo/issues/new'
 : scenario === 'login-redirect' ? 'https://github.com/login?return_to=private'
 : 'https://github.com/owner/repo/issues/new';
class Area {
  constructor() { this.text=scenario==='draft'?'Keep my draft':''; this.id='new_comment_field'; this.placeholder=''; }
  get value() { return this.text; }
  set value(v) { this.text=v; }
  focus() {}
  dispatchEvent(e) {
    if(e.type==='paste') {
      log({action:'paste',bytes:e.clipboardData.files[0].parts[0].length});
      this.text='Uploading file'; return false;
    }
    if(e.type==='input') log({action:'clear',value:this.text});
    return true;
  }
}
const editor=new Area();
const document={readyState:scenario==='loading'?'loading':'complete',
 querySelectorAll:()=>document.readyState==='loading'?[]:[editor],
 querySelector:()=>scenario==='signed-out'?null:{content:'owner'}};
class Transfer { constructor(){this.files=[]; this.items={add:f=>this.files.push(f)};} }
class Event { constructor(type,options={}){this.type=type;Object.assign(this,options);} }
class File { constructor(parts,name,options){this.parts=parts;this.name=name;this.options=options;} }
const storagePath=process.env.CALLS+'.storage';
const stored=fs.existsSync(storagePath)?JSON.parse(fs.readFileSync(storagePath,'utf8')):{};
const localStorage={getItem:k=>scenario==='corrupt-storage' && stored[k]?.length>200000 ? 'BBBB'+stored[k].slice(4) : stored[k]??null,setItem:(k,v)=>{stored[k]=v;fs.writeFileSync(storagePath,JSON.stringify(stored));},removeItem:k=>{delete stored[k];fs.writeFileSync(storagePath,JSON.stringify(stored));}};
log({expressionLength:expression.length});
const context={localStorage,crypto:require('node:crypto').webcrypto,URL,location:new URL(origin),document,window:{HTMLTextAreaElement:Area},
 DataTransfer:Transfer,ClipboardEvent:Event,Event,File,Uint8Array,
 atob:s=>Buffer.from(s,'base64').toString('binary'),
 setTimeout:fn=>{document.readyState='complete';if(editor.text==='Uploading file')editor.text=scenario==='pdf'?'[lesson.pdf](https://github.com/user-attachments/files/0000000000/lesson.pdf)':'![shot](https://github.com/user-attachments/assets/${asset})';queueMicrotask(fn);}};
Promise.resolve(vm.runInNewContext(expression,context)).then(result=>reply({origin,result})).catch(e=>{console.error(e.message);process.exitCode=1;});
`;

function run(scenario, size = 1024, format = 'url') {
  const dir = mkdtempSync(join(tmpdir(), 'orca-upload-test-'));
  try {
    writeFileSync(join(dir, 'orca'), fixture, { mode: 0o755 });
    const filename=scenario==='pdf'?'lesson.pdf':'shot.png';
    writeFileSync(join(dir, filename), Buffer.alloc(size));
    const result = spawnSync('bash', [mint, join(dir, filename), '--format', format, '--repo', 'owner/repo', '--driver', 'orca', '--timeout', '5'], {
      env: { ...process.env, PATH: dir + ':' + process.env.PATH, CALLS: join(dir, 'calls'), CASE: scenario },
      encoding: 'utf8', timeout: 20_000,
    });
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
    return { ...result, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const scenario of ['success', 'loading']) {
  test(scenario + ': pastes and polls in one evaluation, returns the asset, clears its draft and closes its page', () => {
    const result = run(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'https://github.com/user-attachments/assets/' + asset);
    assert.equal(result.calls.filter(c=>c.action==='paste').length,1);
    assert.deepEqual(result.calls.find(c=>c.action==='paste'),{action:'paste',bytes:1024});
    assert.deepEqual(result.calls.find(c=>c.action==='clear'),{action:'clear',value:''});
    assert.ok(result.calls.some(c => c.command?.[1] === 'close' && c.page === page));
  });
}
for (const [scenario, exit] of [['signed-out', 4], ['login-redirect',4], ['wrong-repo', 5], ['draft',5], ['malformed',3]]) {
  test(scenario + ': refuses before paste and closes its page', () => {
    const result = run(scenario);
    assert.equal(result.status, exit, result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(!result.calls.some(c => c.action === 'paste' || c.action === 'clear'));
    assert.ok(result.calls.some(c => c.command?.[1] === 'close' && c.page === page));
  });
}

test('multi-megabyte PDF crosses bounded calls and returns a document link', () => {
  const result = run('pdf', 2 * 1024 * 1024, 'markdown');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '[lesson.pdf](https://github.com/user-attachments/files/0000000000/lesson.pdf)');
  assert.equal(result.calls.filter(c=>c.action==='paste').length,1);
  assert.equal(result.calls.find(c=>c.action==='paste').bytes,2*1024*1024);
  assert.ok(result.calls.filter(c=>c.expressionLength).every(c=>c.expressionLength<128*1024));
  assert.ok(result.calls.some(c=>c.action==='clear'));
  assert.ok(result.calls.some(c=>c.command?.[1]==='close'));
});

test('PDF HTML output is a link', () => {
 const result=run('pdf',1024,'html');
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout.trim(), '<a href="https://github.com/user-attachments/files/0000000000/lesson.pdf">lesson.pdf</a>');
});

test('a large file waits for its new tab to leave about:blank before staging', () => {
 const result=run('blank-once',70*1024);
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout.trim(),'https://github.com/user-attachments/assets/'+asset);
 assert.equal(result.calls.filter(c=>c.action==='paste').length,1);
});

test('staging accepts the repository issue editor with query parameters', () => {
 const result=run('query',70*1024);
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.calls.filter(c=>c.action==='paste').length,1);
});

test('a transient blank context between chunks does not lose or duplicate bytes', () => {
 const result=run('blank-mid-transfer',2*1024*1024);
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.calls.filter(c=>c.action==='paste').length,1);
 assert.equal(result.calls.find(c=>c.action==='paste').bytes,2*1024*1024);
});

test('corrupted staged bytes are rejected before any paste', () => {
 const result=run('corrupt-storage',300*1024);
 assert.equal(result.status,6,result.stderr);
 assert.match(result.stderr,/checksum mismatch/);
 assert.equal(result.calls.filter(c=>c.action==='paste').length,0);
 assert.equal(result.stdout,'');
});
