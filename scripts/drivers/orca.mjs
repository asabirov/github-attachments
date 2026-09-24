import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const [image, repo, timeout] = process.argv.slice(2);
const target = `https://github.com/${repo}/issues/new`;
const library = readFileSync(new URL('../../lib/paste.js', import.meta.url), 'utf8');
const bytes = readFileSync(image);
let page;
const storageKey = "github-attachment-transfer-" + randomUUID();

function call(args) {
  const result = spawnSync('orca', [...args, '--json'], {
    encoding: 'utf8', timeout: (Number(timeout) + 20) * 1000, maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === 'E2BIG') throw Error('Image exceeds the Orca CLI argument limit; use the Chrome driver');
    throw Error(`Orca command failed: ${result.error.code}`);
  }
  let reply;
  try { reply = JSON.parse(result.stdout); }
  catch { throw Error(`Orca returned no valid JSON (exit ${result.status})`); }
  if (result.status !== 0 || !reply.ok) throw Error(reply.error?.message || 'Orca command failed');
  return reply.result;
}

// Paste, poll, and clear in one evaluation: Orca can discard globals and DOM
// mutations between separate evaluations even when their URL is unchanged.
async function upload(target, base64, name, mime, timeoutMs, storageKey, expectedDigest) {
  const expected = new URL(target);
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const checkPage = () => {
    if (location.href === 'about:blank') return { code: 9, error: 'Upload page is blank' };
    if (location.origin === expected.origin && /^\/(login|session)(\/|$)/.test(location.pathname))
      return { code: 4, error: 'Browser is not signed in to GitHub' };
    if (location.origin !== expected.origin || location.pathname !== expected.pathname)
      return { code: 5, error: 'Upload page is not the expected repository' };
  };
  let wrong = checkPage();
  if (wrong) return wrong;
  const readyBy = Date.now() + 10000;
  while (document.readyState === 'loading' && Date.now() < readyBy) await pause();
  wrong = checkPage();
  if (wrong) return wrong;
  const helper = globalThis.__ghAttach;
  if (!helper.whoami()) return { code: 4, error: 'Browser is not signed in to GitHub' };
  while (!helper.editors().length && Date.now() < readyBy) await pause();
  wrong = checkPage();
  if (wrong) return wrong;
  if (document.readyState === 'loading' || !helper.editors().length)
    return { code: 5, error: 'No ready comment editor on upload page' };
  if (helper.editors()[0].value.trim())
    return { code: 5, error: 'Upload editor contains an existing draft; left untouched' };
  try {
    if (base64 === null) {
      base64 = localStorage.getItem(storageKey);
      localStorage.removeItem(storageKey);
      if (!base64) return { code: 6, error: 'Missing staged file' };
    }
    const decoded = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', decoded)))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== expectedDigest) return { code: 6, error: 'Attachment checksum mismatch before paste' };
    const pasted = helper.paste(base64, name, mime);
    if (!pasted.ok) return { code: 6, error: `Editor did not accept the paste: ${pasted.reason}` };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = helper.harvest();
      if (result.state === 'done') return { code: 0, url: result.url };
      await pause();
    }
    return { code: 7, error: 'Timed out waiting for GitHub attachment URL' };
  } finally { helper.clear(); }
}

let code = 3;
try {
  page = call(['tab', 'create', '--url', target]).browserPageId;
  if (typeof page !== 'string' || !/^[0-9a-f-]{36}$/.test(page)) throw Error('Orca did not return a page ID');
  const mimeResult = spawnSync('file', ['--mime-type', '-b', image], { encoding: 'utf8' });
  if (mimeResult.status !== 0) throw Error('Cannot identify image MIME type');
  let base64 = bytes.toString('base64');
  if (base64.length > 90000) {
    // Origin storage survives Orca's recreated evaluation contexts. The key is unique;
    // bounded arguments avoid both Linux's per-argument limit and macOS ARG_MAX.
    const stage = async expression => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const reply = call(['eval', '--page', page, '--expression', expression]);
        const state = JSON.parse(reply.result);
        if (state?.staged === true) return;
        // Orca can briefly return a blank context between chunks as well.
        // This result is emitted before append, so retry cannot duplicate bytes.
        if (!state?.blank) throw Error('Could not stage attachment bytes');
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw Error('Upload page remained blank during staging');
    };
    // A newly created Orca tab can still be blank. Retry only this read-only
    // readiness probe, before staging or pasting any bytes.
    let ready = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = call(['eval', '--page', page, '--expression', `JSON.stringify({blank:location.href==='about:blank',ready:location.origin+location.pathname===${JSON.stringify(target)}})`]);
      const state = JSON.parse(reply.result);
      if (state.ready) { ready = true; break; }
      if (!state.blank) throw Error('Unexpected upload page');
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw Error('Upload page remained blank before staging');
    await stage(`(() => { if (location.href==='about:blank') return JSON.stringify({blank:true}); if (location.origin+location.pathname !== ${JSON.stringify(target)}) throw Error('Unexpected upload page: '+location.origin+location.pathname); localStorage.setItem(${JSON.stringify(storageKey)}, ''); return JSON.stringify({staged:true}); })()`);
    for (let offset = 0; offset < base64.length; offset += 90000) {
      await stage(`(() => { if (location.href==='about:blank') return JSON.stringify({blank:true}); if (location.origin+location.pathname !== ${JSON.stringify(target)}) throw Error('Unexpected upload page: '+location.origin+location.pathname); const key=${JSON.stringify(storageKey)}; const prior=localStorage.getItem(key); if (prior===null || prior.length!==${offset}) throw Error('Staged attachment lost or changed'); localStorage.setItem(key, prior+${JSON.stringify(base64.slice(offset, offset + 90000))}); return JSON.stringify({staged:true}); })()`);
    }
    base64 = null;
  }
  const args = [target, base64, basename(image), mimeResult.stdout.trim(), Number(timeout) * 1000, storageKey, createHash('sha256').update(bytes).digest('hex')];
  const expression = `(async () => { ${library}\nreturn JSON.stringify(await (${upload.toString()})(...${JSON.stringify(args)})); })()`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = call(['eval', '--page', page, '--expression', expression]);
    const result = JSON.parse(reply.result);
    if (!result || ![0, 3, 4, 5, 6, 7, 9].includes(result.code)) throw Error('Upload returned no valid outcome');
    // Blank-page replies occur before paste; never retry an uncertain upload.
    if (result.code === 9 && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    code = result.code === 9 ? 3 : result.code;
    if (code === 0) {
      if (!/^https:\/\/github\.com\/user-attachments\/(assets\/[0-9a-f-]{36}|files\/\d+\/[^\s)"<>]+)$/.test(result.url))
        throw Error('Upload returned no valid attachment URL');
      process.stdout.write(result.url + '\n');
    } else console.error(`orca: ${result.error || 'Upload failed'}`);
    break;
  }
} catch (error) {
  code = 3;
  console.error(`orca: ${error.message}`);
} finally {
  if (page) {
    let cleared = false;
    for (let attempt = 0; attempt < 3 && !cleared; attempt++) {
      try {
        const reply = call(['eval', '--page', page, '--expression', `(() => { if (location.origin !== 'https://github.com') return JSON.stringify({cleared:false}); localStorage.removeItem(${JSON.stringify(storageKey)}); return JSON.stringify({cleared:true}); })()`]);
        cleared = JSON.parse(reply.result)?.cleared === true;
      } catch {}
      if (!cleared && attempt < 2) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!cleared) console.error(`orca: could not verify staging cleanup; remove localStorage key ${storageKey} on github.com`);
    try { call(['tab', 'close', '--page', page]); }
    catch { console.error(`orca: could not close upload tab ${page}`); }
  }
}
process.exitCode = code;
