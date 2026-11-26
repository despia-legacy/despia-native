'use strict';

// Test harness: loads an SDK build into an isolated vm context that plays
// the part of a WebView page, with a virtual clock and fake native bridges.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CURRENT = path.join(ROOT, 'index.js');
const RELEASE_1_0_28 = path.join(__dirname, 'fixtures', 'index-1.0.28.js');

const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DESPIA_UA = BROWSER_UA + ' despia';

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
//   ios         (msg) => reply | Promise<reply>  installs webkit.messageHandlers.despia
//   android     (msg, env) => void               installs window.despia_bridge
//   androidOnMessage  use bridge.onmessage instead of addEventListener
//   noWindow    load without window (server-side rendering)
//   context     reuse an existing env's context (second SDK copy on one page)
function loadSdk(opts = {}) {
  const file = opts.file || CURRENT;
  const source = fs.readFileSync(file, 'utf8');
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

    if (opts.ios) {
      win.webkit = {
        messageHandlers: {
          despia: {
            postMessage(msg) {
              posted.push(JSON.parse(JSON.stringify(msg)));
              return opts.ios(msg, env);
            }
          }
        }
      };
    }

    if (opts.android) {
      const listeners = [];
      const bridge = {
        postMessage(json) {
          if (typeof json !== 'string') throw new TypeError('android bridge only accepts strings');
          const msg = JSON.parse(json);
          posted.push(msg);
          opts.android(msg, env);
        }
      };
      if (opts.androidOnMessage) {
        bridge.onmessage = null;
      } else {
        bridge.addEventListener = (type, fn) => { if (type === 'message') listeners.push(fn); };
      }
      win.despia_bridge = bridge;
      // Native -> page message over the listener object.
      env.androidSend = (obj) => {
        const event = { data: typeof obj === 'string' ? obj : JSON.stringify(obj) };
        if (opts.androidOnMessage) {
          if (typeof bridge.onmessage === 'function') bridge.onmessage(event);
        } else {
          listeners.slice().forEach((fn) => fn(event));
        }
      };
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
  ROOT, CURRENT, RELEASE_1_0_28, BROWSER_UA, DESPIA_UA,
  loadSdk, createClock, plain, outcome
};
