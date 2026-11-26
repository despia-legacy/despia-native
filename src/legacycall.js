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

function watchList(legacy, args) {
  return [].concat(legacy.variable || []).map((name) => fillTemplate(name, args));
}

// The app's answer envelope: { ok: true, data } or { ok: false, error: { code, message } }.
function unwrapEnvelope(value) {
  if (value === null || typeof value !== 'object' || typeof value.ok !== 'boolean') return value;
  if (value.ok) return value.data;
  const err = value.error && typeof value.error === 'object' ? value.error : {};
  throw new DespiaError(
    typeof err.code === 'string' && err.code ? err.code : ErrorCodes.INTERNAL,
    typeof err.message === 'string' ? err.message : 'Native call failed'
  );
}

function legacyCall(despiaFunction, feature, action, legacy, args) {
  const command = buildCommand(legacy, args);
  const watch = legacy.answer === 'none' ? [] : watchList(legacy, args);
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
