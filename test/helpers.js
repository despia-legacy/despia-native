'use strict';

// Test harness: loads an SDK build into an isolated vm context that plays
// the part of a WebView page, with a virtual clock and fake native bridges.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { build } = require('../scripts/build');
const { generate, readCatalogs } = require('../scripts/generate-features');
const CURRENT = path.join(ROOT, 'index.js');
const RELEASE_1_0_28 = path.join(__dirname, 'fixtures', 'index-1.0.28.js');

const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DESPIA_UA = BROWSER_UA + ' despia';
const FIXTURE_CATALOG = path.join(__dirname, 'fixtures', 'bridge-catalog.json');

// Bundle of the SDK with the fixture catalog compiled in.
let fixtureBundle = null;
function fixtureSource() {
  if (!fixtureBundle) {
    fixtureBundle = build({ features: generate(readCatalogs([FIXTURE_CATALOG])).js });
  }
  return fixtureBundle;
}

const ok = (value) => ({ v: 1, t: 'reply', id: 'x', ok: true, value });
const fail = (code, message, extra) => ({
  v: 1, t: 'reply', id: 'x', ok: false, error: Object.assign({ code, message: message || code }, extra)
});

const HELLO = {
  v: 1,
  platform: 'ios',
  features: {
    media: { version: '1.0.0', actions: ['pick', 'embedded_hide'], events: [] },
    ffmpeg: { version: '1.0.0', actions: ['run'], events: ['progress', 'log', 'done'] },
    notes: { version: '1.0.0', actions: ['get', 'search', 'set_expiry'], events: [] }
  },
  limits: { maxMessageBytes: 4194304, maxInFlight: 64 }
};

function createClock() {
  let now = 1700000000000;
  let nextId = 1;
  const timers = new Map();

  function add(fn, ms, args, repeat) {
    const id = nextId++;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { fn, args, at: now + delay, delay, repeat, seq: id });
    return id;
  }

  function nextDue(limit) {
    let best = null;
    for (const [id, t] of timers) {
      if (t.at > limit) continue;
      if (!best || t.at < best.t.at || (t.at === best.t.at && t.seq < best.t.seq)) best = { id, t };
    }
    return best;
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  return {
    get now() { return now; },
    setTimeout: (fn, ms, ...args) => add(fn, ms, args, false),
    setInterval: (fn, ms, ...args) => add(fn, ms, args, true),
    clearTimeout: (id) => { timers.delete(id); },
    clearInterval: (id) => { timers.delete(id); },
    pending: () => timers.size,
    // Advances virtual time, running due timers in order and letting
    // promise callbacks settle between them.
    async tick(ms = 0) {
      const target = now + ms;
      await flush();
      for (;;) {
        const due = nextDue(target);
        if (!due) break;
        now = due.t.at;
        if (due.t.repeat) {
          due.t.at = now + Math.max(1, due.t.delay);
          due.t.seq = nextId++;
        } else {
          timers.delete(due.id);
        }
        due.t.fn(...due.t.args);
        await flush();
      }
      now = target;
      await flush();
    }
  };
}

// opts:
//   file        SDK file to load (default: index.js)
//   userAgent   navigator.userAgent (default: plain browser)
//   mode        'cjs' (module.exports) or 'global' (script tag)
//   onCommand   (command, win) => void, called for each legacy window.despia assignment
//   source      SDK source text to run instead of a file
//   fixture     true: bundle the SDK with test/fixtures/bridge-catalog.json
//   bridge      (call, env) => reply | Promise<reply>  installs window.despiaBridge
//               call = { feature, action, args, opts }; never sees bridge.hello
//   hello       the hello value (default HELLO); null = refuse it with forbidden_origin;
//               a function (call, env) => reply answers it itself
//   env.emit(packet)   native -> page event; env.calls records every native call
//   noWindow    load without window (server-side rendering)
//   context     reuse an existing env's context (second SDK copy on one page)
function loadSdk(opts = {}) {
  const file = opts.file || CURRENT;
  const source = opts.source || (opts.fixture ? fixtureSource() : fs.readFileSync(file, 'utf8'));
  const log = [];

  let env;
  if (opts.context) {
    env = Object.assign({}, opts.context);
  } else {
    const clock = createClock();
    const context = vm.createContext({});
    const win = vm.runInContext('this', context);
    const commands = [];
    const posted = [];
    const consoleErrors = [];

    win.setTimeout = clock.setTimeout;
    win.setInterval = clock.setInterval;
    win.clearTimeout = clock.clearTimeout;
    win.clearInterval = clock.clearInterval;
    const ContextDate = vm.runInContext('Date', context);
    win.Date = class extends ContextDate {
      static now() { return clock.now; }
    };
    win.console = {
      log() {},
      warn() {},
      error: (...args) => consoleErrors.push(args.map(String).join(' '))
    };

    env = { context, win, clock, commands, posted, consoleErrors, log };

    if (!opts.noWindow) {
      win.window = win;
      win.self = win;
      win.navigator = { userAgent: opts.userAgent || BROWSER_UA };
      win.document = {
        createElement: () => ({ style: {}, remove() {} }),
        body: { appendChild() {} }
      };
      win.MutationObserver = class {
        observe() {}
        disconnect() {}
      };

      // Native side of the legacy channel: record every window.despia assignment.
      Object.defineProperty(win, 'despia', {
        configurable: true,
        get() { return undefined; },
        set(value) {
          commands.push(value);
          if (opts.onCommand && typeof value === 'string') opts.onCommand(value, win);
        }
      });
    }

    if (opts.bridge) {
      const listeners = [];
      const calls = [];
      env.calls = calls;
      env.listeners = listeners;
      const native = Object.freeze({
        v: 1,
        platform: 'ios',
        call(feature, action, args, callOpts) {
          const call = {
            feature, action, args: plain(args),
            opts: callOpts === undefined ? undefined : plain(callOpts),
            argc: arguments.length
          };
          calls.push(call);
          let reply;
          if (feature === 'bridge' && action === 'hello') {
            if (opts.hello === null) reply = fail('forbidden_origin', 'not the app origin');
            else if (typeof opts.hello === 'function') reply = opts.hello(call, env);
            else reply = ok(opts.hello || HELLO);
          } else {
            reply = opts.bridge(call, env);
          }
          return Promise.resolve(reply);
        },
        listen(fn) {
          listeners.push(fn);
          return () => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); };
        }
      });
      Object.defineProperty(win, 'despiaBridge', { value: native, enumerable: false });
      env.emit = (packet) => listeners.slice().forEach((fn) => fn(Object.assign({ v: 1, t: 'event' }, packet)));
    }
  }

  const module = { exports: {} };
  if (opts.mode !== 'global') {
    env.win.module = module;
  } else {
    delete env.win.module;
  }
  vm.runInContext(source, env.context, { filename: path.basename(file) });
  delete env.win.module;

  env.despia = opts.mode === 'global' ? env.commands[env.commands.length - 1] : module.exports;
  return env;
}

// Copies a value out of the vm realm so deepStrictEqual can compare it.
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Captures a promise's outcome without letting a rejection go unhandled.
function outcome(promise) {
  const box = { settled: false };
  box.done = promise.then(
    (value) => { box.settled = true; box.value = value; },
    (error) => { box.settled = true; box.error = error; }
  );
  return box;
}

module.exports = {
  ROOT, CURRENT, RELEASE_1_0_28, BROWSER_UA, DESPIA_UA, FIXTURE_CATALOG, HELLO,
  ok, fail, loadSdk, createClock, plain, outcome
};
