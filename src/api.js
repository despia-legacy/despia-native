'use strict';

// Typed API: despia.<feature>.<action>(args) and despia.<feature>.on(event, fn).
// Routes each call to the JSON bridge, else to the feature's legacy scheme,
// else rejects with not_in_app.

const { DespiaError, ErrorCodes } = require('./errors');

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

// Returns an error message, or null when args satisfy the spec.
function validateArgs(feature, action, params, args) {
  const where = feature + '.' + action;
  for (const name of Object.keys(params || {})) {
    const spec = params[name];
    const value = args[name];
    if (value === undefined) {
      if (spec.required) return where + ': "' + name + '" is required';
      continue;
    }
    if (spec.type && !matchesType(spec.type, value)) {
      return where + ': "' + name + '" must be ' + spec.type + ', got ' + typeOf(value);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return where + ': "' + name + '" must be finite';
    }
    const size = typeof value === 'number' ? value
      : (typeof value === 'string' || Array.isArray(value)) ? value.length
      : undefined;
    const unit = typeof value === 'number' ? '' : ' in length';
    if (size !== undefined && spec.min !== undefined && size < spec.min) {
      return where + ': "' + name + '" must be at least ' + spec.min + unit;
    }
    if (size !== undefined && spec.max !== undefined && size > spec.max) {
      return where + ': "' + name + '" must be at most ' + spec.max + unit;
    }
  }
  return null;
}

function fillTemplate(template, args) {
  return template.replace(/\{([^}]+)\}/g, (_, name) => String(args[name]));
}

function buildLegacyCommand(legacy, args) {
  const parts = [];
  const query = legacy.query || {};
  for (const key of Object.keys(query)) {
    const value = args[query[key]];
    if (value === undefined || value === null) continue;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    parts.push(key + '=' + encodeURIComponent(text));
  }
  return parts.length ? legacy.scheme + '?' + parts.join('&') : legacy.scheme;
}

function createApi({ features, transport, hub, despiaFunction }) {
  function legacyCall(feature, action, legacy, args) {
    const command = buildLegacyCommand(legacy, args);
    const watch = (legacy.watch || []).map((name) => fillTemplate(name, args));
    if (watch.length === 0) {
      return despiaFunction(command).then(() => undefined);
    }
    return despiaFunction(command, watch).then((values) => {
      values = values || {};
      const missing = watch.filter((name) => values[name] === undefined);
      if (missing.length) {
        throw new DespiaError(
          ErrorCodes.TIMEOUT,
          feature + '.' + action + ': no reply in ' + missing.join(', ')
        );
      }
      return legacy.result ? values[fillTemplate(legacy.result, args)] : values;
    });
  }

  function call(feature, action, spec, args) {
    if (args === undefined || args === null) args = {};
    if (!isPlainObject(args)) {
      return Promise.reject(new DespiaError(
        ErrorCodes.INVALID_ARGS, feature + '.' + action + ': args must be a plain object'
      ));
    }
    const problem = validateArgs(feature, action, spec.params, args);
    if (problem) return Promise.reject(new DespiaError(ErrorCodes.INVALID_ARGS, problem));

    const mode = transport.mode();
    if (mode === 'ios' || mode === 'android') {
      return transport.request(feature, action, args);
    }
    if (mode === 'legacy') {
      if (!spec.legacy) {
        return Promise.reject(new DespiaError(
          ErrorCodes.UNSUPPORTED,
          feature + '.' + action + ' needs a newer app build (no legacy scheme)'
        ));
      }
      try {
        return legacyCall(feature, action, spec.legacy, args);
      } catch (e) {
        return Promise.reject(new DespiaError(ErrorCodes.BRIDGE_ERROR, e && e.message));
      }
    }
    return Promise.reject(new DespiaError(
      ErrorCodes.NOT_IN_APP,
      feature + '.' + action + ' is only available inside the Despia app'
    ));
  }

  function createFeature(feature) {
    const spec = features[feature];
    const ns = {};
    Object.keys(spec.actions).forEach((action) => {
      const actionSpec = spec.actions[action];
      ns[action] = function (args) {
        return call(feature, action, actionSpec, args);
      };
    });
    ns.on = function (event, fn) {
      return hub.on(feature, event, fn);
    };
    return Object.freeze(ns);
  }

  const namespaces = {};
  Object.keys(features).forEach((feature) => {
    namespaces[feature] = createFeature(feature);
  });

  return { namespaces, validateArgs, buildLegacyCommand };
}

module.exports = { createApi };
