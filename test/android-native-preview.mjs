// Private device proof driver. Loads exact WIP UMD as a module without replacing
// window.despia or the real native DSX bridge. Output contains structural facts only.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sdk = readFileSync(process.argv[2], 'utf8');
const tabs = await (await fetch('http://127.0.0.1:9229/json/list')).json();
let found = false;
for (const tab of tabs) {
  if (!tab.webSocketDebuggerUrl) continue;
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  };
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, message => {
      if (message.result?.exceptionDetails || message.error) reject(new Error('Private native preview execution failed'));
      else resolve(message.result?.result?.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  const ready = await evaluate('typeof window.despia === "function" && typeof window.dsx?.module?.clipboard?.write === "function"');
  if (!ready) { ws.close(); continue; }
  const result = await evaluate(`(async () => {
    const nativeCommand = window.despia;
    const module = { exports: {} };
    new Function('module', 'exports', ${JSON.stringify(sdk)})(module, module.exports);
    const consumer = module.exports;
    const bounded = promise => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve({ previewTimeout: true }), 8000))]);
    const history = await bounded(consumer('getpurchasehistory://', ['restoredData']));
    await window.dsx.module.clipboard.write({ text: '' });
    const clipboard = await bounded(consumer('getclipboard://', ['clipboarddata']));
    const contacts = await bounded(consumer('readcontacts://', ['contacts']));
    const c = contacts.contacts;
    return {
      nativeBridgeUnchanged: window.despia === nativeCommand,
      history: { completed: !history.previewTimeout, nullResult: history.restoredData === null, arrayResult: Array.isArray(history.restoredData) },
      clipboard: { completed: !clipboard.previewTimeout, emptyString: clipboard.clipboarddata === '', type: typeof clipboard.clipboarddata },
      contacts: { completed: !contacts.previewTimeout, directObject: c !== null && typeof c === 'object' && !Array.isArray(c), count: c && typeof c === 'object' ? Object.keys(c).length : 0, phoneArrays: c !== null && typeof c === 'object' && Object.values(c).every(a => Array.isArray(a) && a.every(v => typeof v === 'string')) }
    };
  })()`);
  const receipt = { sdkCommit: '74371c8557e26c592143d5a2670194fedbd45cab', sdkSourceSha256: createHash('sha256').update(sdk).digest('hex'), platform: 'actual-android-emulator-5554', apkNativeBase: 'existing-converter50', mapOnlyApkSha256: '0340c7baac433c6b5d81114de8f325b076fdc7b339b1596ea53a52e356681549', privatePreview: true, nativeBuild: false, publicPublication: false, observedAt: new Date().toISOString(), ...result };
  writeFileSync(process.argv[3], JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
  ws.close(); found = true; break;
}
if (!found) throw new Error('Owned native fixture tab unavailable');
