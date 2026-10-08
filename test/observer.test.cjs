const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Execute the shipping entry point, including its public callable and command queue.
// Controlled timers keep timeout tests deterministic without changing SDK timeouts.
function runtime(onCommand) {
  let now = 0, nextId = 1;
  const timers = new Map();
  const window = {};
  const schedule = (fn, delay, repeat) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + delay, repeat });
    return id;
  };
  Object.defineProperty(window, 'despia', {
    configurable: true,
    set(command) { onCommand(command, window, (fn, ms = 10) => schedule(fn, ms, 0)); },
  });
  const context = {
    window, module: { exports: {} }, console: { error() {} },
    Date: { now: () => now },
    setTimeout: (fn, ms) => schedule(fn, ms, 0),
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, ms),
    clearInterval: id => timers.delete(id),
    document: {
      createElement: () => ({ style: {}, remove() {} }),
      body: { appendChild() {} },
    },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'), context);
  return {
    window,
    call: context.module.exports,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.repeat) timer.at += timer.repeat;
        else timers.delete(id);
        timer.fn();
        await Promise.resolve();
      }
      now = end;
      await Promise.resolve();
    },
  };
}

for (const [name, value] of [
  ['empty array', []], ['empty object', {}], ['null', null],
  ['empty string', ''], ['false', false], ['zero', 0],
]) {
  test(`single watcher completes with fresh ${name}`, async () => {
    const r = runtime((command, w, later) => later(() => { w.result = value; }));
    let result;
    r.call('read://', ['result']).then(v => { result = v; });
    await r.advance(100);
    assert.ok(result, 'valid native reply must complete without timing out');
    assert.strictEqual(result.result, value);
  });
}

test('multi watcher completes when one response is explicit null', async () => {
  const r = runtime((command, w, later) => later(() => {
    w.unavailable = null;
    w.available = [];
  }));
  let result;
  r.call('read://', ['unavailable', 'available']).then(v => { result = v; });
  await r.advance(1000);
  assert.ok(result, 'explicit unavailability is a terminal response');
  assert.equal(result.unavailable, null);
  assert.ok(Array.isArray(result.available));
});

test('watch setup precedes synchronous native command completion', async () => {
  const r = runtime((command, w) => { w.result = []; });
  r.window.result = { stale: true };
  let result;
  r.call('read://', ['result']).then(v => { result = v; });
  await r.advance(100);
  assert.ok(result, 'clear/observation must not erase a synchronous response');
  assert.ok(Array.isArray(result.result));
});

test('stale globals are cleared and cannot complete a new request', async () => {
  const r = runtime((command, w, later) => later(() => { w.result = 'fresh'; }, 500));
  r.window.result = 'stale';
  let result;
  r.call('read://', ['result']).then(v => { result = v; });
  await r.advance(400);
  assert.equal(result, undefined);
  await r.advance(100);
  assert.equal(result.result, 'fresh');
});

for (const value of [undefined, 'n/a']) {
  test(`missing response ${String(value)} retains 30-second timeout`, async () => {
    const r = runtime((command, w, later) => later(() => { w.result = value; }));
    let result;
    r.call('read://', ['result']).then(v => { result = v; });
    await r.advance(29999);
    assert.equal(result, undefined);
    await r.advance(1);
    assert.ok(result);
    assert.equal(result.result, undefined);
  });
}

test('multi watcher waits for every variable and retains five-minute timeout', async () => {
  const r = runtime((command, w, later) => later(() => { w.first = null; }));
  let result;
  r.call('read://', ['first', 'missing']).then(v => { result = v; });
  await r.advance(299999);
  assert.equal(result, undefined);
  await r.advance(1);
  assert.ok(result);
  assert.equal(Object.keys(result).length, 0);
});

test('commands without watches still dispatch and resolve without response', async () => {
  let sent;
  const r = runtime(command => { sent = command; });
  await r.call('fire://');
  assert.equal(sent, 'fire://');
});
