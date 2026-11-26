'use strict';

// Fallback for a document without the JSON bridge: the typed call becomes
// the scheme URL the SDK has always sent, `despia(command, watch)`.
//
// Catalog mapping of one action:
//   legacy: {
//     scheme, host?, route?,              // scheme://host/route
//     args: [{ arg, name, encoding }],    // query parameters, in order
//     variable?,                          // window variable(s) the app answers in
//     answer: 'none' | 'variable' | 'envelope'
//   }
// `variable` may be a name, a list of names, and may hold {argName} templates.

const { DespiaError, ErrorCodes } = require('./errors');
const { jsNameOK } = require('./names');

function fillTemplate(template, args) {
  return template.replace(/\{([^}]+)\}/g, (_, name) => String(args[name]));
}

function buildCommand(legacy, args) {
  let command = legacy.scheme + '://' + (legacy.host || '') + (legacy.route ? '/' + legacy.route : '');
  const parts = [];
  (legacy.args || []).forEach((entry) => {
    const value = args[entry.arg];
    if (value === undefined || value === null) return;
    const text = entry.encoding === 'json' ? JSON.stringify(value) : String(value);
    parts.push(entry.name + '=' + encodeURIComponent(text));
  });
  if (parts.length) command += '?' + parts.join('&');
  return command;
}

// Names that exist on window when the SDK loads: the browser's own, from the
// window object and its prototype chain.
const BUILTIN = (() => {
  const names = new Set();
  if (typeof window === 'undefined' || window === null) return names;
  try {
    for (let o = window; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      Object.getOwnPropertyNames(o).forEach((n) => names.add(n));
    }
  } catch (e) { /* keep what was read */ }
  return names;
})();

function freeToClear(name) {
  if (typeof window === 'undefined' || window === null) return true;
  try {
    if (BUILTIN.has(name)) return false;
    if (!(name in window)) return true;
    const d = Object.getOwnPropertyDescriptor(window, name);
    if (!d || !d.configurable || !d.writable || !('value' in d)) return false;
    const type = typeof d.value;
    return d.value === undefined || (d.value !== null && type !== 'object' && type !== 'function');
  } catch (e) {
    return false;
  }
}

// The window variables to watch, with names filled in from args. Every name
// must be one the legacy channel may delete and wait on; an arg that would
// turn into a browser global is refused before anything is sent.
function watchList(feature, action, legacy, args) {
  return [].concat(legacy.variable || []).map((template) => {
    const name = fillTemplate(template, args);
    const arg = (/\{([^}]+)\}/.exec(template) || [])[1];
    const refuse = (why) => new DespiaError(
      ErrorCodes.BAD_ARGS,
      feature + '.' + action + ': "' + name + '" ' + why,
      arg ? 'args.' + arg : undefined
    );
    if (!jsNameOK(name)) throw refuse('cannot be used as a window variable name');
    // A name built from an argument is deleted before the app answers, so it
    // may only be one that is free, or one an earlier answer left as a plain
    // value. Browser properties, getters and anything holding an object or
    // function are refused.
    if (arg !== undefined && name !== template && !freeToClear(name)) throw refuse('is already in use on this page');
    return name;
  });
}

// The app's answer envelope: { ok: true, data } on success; on failure
// { ok: false, error: '<message>', code: '<code>' }. An object-shaped
// `error: { code, message }` is accepted too.
function unwrapEnvelope(value) {
  if (value === null || typeof value !== 'object' || typeof value.ok !== 'boolean') return value;
  if (value.ok) return value.data;
  const err = value.error;
  const detail = err !== null && typeof err === 'object' ? err : {};
  const code = typeof value.code === 'string' && value.code ? value.code
    : typeof detail.code === 'string' && detail.code ? detail.code : ErrorCodes.INTERNAL;
  const message = typeof err === 'string' && err ? err
    : typeof detail.message === 'string' && detail.message ? detail.message : 'Native call failed';
  throw new DespiaError(code, message);
}

function legacyCall(despiaFunction, feature, action, legacy, args) {
  const watch = legacy.answer === 'none' ? [] : watchList(feature, action, legacy, args);
  const command = buildCommand(legacy, args);
  if (watch.length === 0) return despiaFunction(command).then(() => undefined);

  return despiaFunction(command, watch).then((values) => {
    values = values || {};
    const missing = watch.filter((name) => values[name] === undefined);
    if (missing.length) {
      throw new DespiaError(
        ErrorCodes.TIMEOUT,
        feature + '.' + action + ': no reply in ' + missing.join(', ')
      );
    }
    const value = Array.isArray(legacy.variable) ? values : values[watch[0]];
    return legacy.answer === 'envelope' ? unwrapEnvelope(value) : value;
  });
}

module.exports = { legacyCall, buildCommand };
