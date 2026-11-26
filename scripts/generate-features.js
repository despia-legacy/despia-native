#!/usr/bin/env node
'use strict';

// Generator hook: builds the feature map from native routes.json files.
//
//   node scripts/generate-features.js [--out <dir>] routes/*.json
//
// Writes <dir>/features.d.ts (types) and <dir>/src/features.js (runtime
// table), replacing the hand-written versions; <dir> defaults to the repo
// root. Run `npm run build` afterwards to refresh index.js.
//
// The routes.json shape below is provisional and kept in this one file so
// it can follow the native format as that settles:
//
// {
//   "feature": "vault",
//   "description": "optional",
//   "actions": {
//     "get": {
//       "description": "optional",
//       "scheme": "readvault://",          // legacy fallback; omit for JSON-only actions
//       "params": {
//         "key": {
//           "type": "string",               // string | number | integer | boolean | object | array | any
//           "required": true,
//           "min": 1, "max": 64,            // numbers: value range; strings/arrays: length
//           "query": "key",                 // legacy query name (default: param name, false = not sent)
//           "description": "optional",
//           "enum": ["a", "b"],             // optional literal values
//           "items": { "type": "string" },  // arrays
//           "properties": { ... },          // objects (each with its own "required")
//           "additionalProperties": true    // objects: allow extra keys
//         }
//       },
//       "callback": ["{key}"],              // window variables the app writes back ({param} = templated)
//       "returns": "{key}",                 // resolve with this one variable (default: object of all)
//       "result": { "type": "string" }      // result type (default: unknown / void when no callback)
//     }
//   },
//   "events": {                             // or an array of event names (data: unknown)
//     "change": { "description": "optional", "data": { "type": "object", "properties": { ... } } }
//   }
// }

const fs = require('fs');
const path = require('path');

// Names already taken on the despia function object or by the SDK.
const RESERVED_FEATURES = new Set([
  'on', 'legacy', 'DespiaError', 'then', 'call', 'apply', 'bind', 'length', 'name',
  'prototype', 'arguments', 'caller', 'constructor', 'toString', 'valueOf'
]);
const RESERVED_ACTIONS = new Set(['on', 'then']);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'any']);

function fail(where, message) {
  throw new Error(where + ': ' + message);
}

function key(name) {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

function doc(lines, pad) {
  lines = lines.filter(Boolean);
  if (!lines.length) return '';
  if (lines.length === 1) return pad + '/** ' + lines[0] + ' */\n';
  return pad + '/**\n' + lines.map((l) => pad + ' * ' + l).join('\n') + '\n' + pad + ' */\n';
}

function rangeDoc(spec) {
  const length = spec.type === 'string' || spec.type === 'array';
  const out = [];
  if (spec.min !== undefined) out.push((length ? '@minLength ' : '@minimum ') + spec.min);
  if (spec.max !== undefined) out.push((length ? '@maxLength ' : '@maximum ') + spec.max);
  return out.join(' ');
}

function tsType(spec, where, pad) {
  if (!spec || spec.type === undefined || spec.type === 'any') return 'unknown';
  if (!TYPES.has(spec.type)) fail(where, 'unknown type "' + spec.type + '"');
  if (Array.isArray(spec.enum) && spec.enum.length) {
    return spec.enum.map((v) => JSON.stringify(v)).join(' | ');
  }
  switch (spec.type) {
    case 'string': return 'string';
    case 'number':
    case 'integer': return 'number';
    case 'boolean': return 'boolean';
    case 'array': {
      const item = tsType(spec.items, where + '[]', pad);
      return /^[\w.]+$/.test(item) ? item + '[]' : 'Array<' + item + '>';
    }
    case 'object': {
      const props = spec.properties || {};
      const names = Object.keys(props);
      if (!names.length) return spec.additionalProperties === false ? '{}' : 'Record<string, unknown>';
      return objectType(props, where, pad, spec.additionalProperties === true);
    }
  }
  return 'unknown';
}

function objectType(props, where, pad, open) {
  const inner = pad + '  ';
  let out = '{\n';
  for (const name of Object.keys(props)) {
    const p = props[name] || {};
    out += doc([[p.description, rangeDoc(p)].filter(Boolean).join(' ')], inner);
    out += inner + key(name) + (p.required ? '' : '?') + ': ' + tsType(p, where + '.' + name, inner) + ';\n';
  }
  if (open) out += inner + '[key: string]: unknown;\n';
  return out + pad + '}';
}

function normaliseEvents(events, where) {
  if (!events) return {};
  if (Array.isArray(events)) {
    const out = {};
    events.forEach((name) => { out[name] = {}; });
    return out;
  }
  if (typeof events !== 'object') fail(where, '"events" must be an object or an array');
  return events;
}

function checkRoute(route, file) {
  const where = file || 'routes';
  if (!route || typeof route !== 'object') fail(where, 'not an object');
  const feature = route.feature;
  if (typeof feature !== 'string' || !IDENT.test(feature)) fail(where, 'invalid "feature" name');
  if (RESERVED_FEATURES.has(feature)) fail(where, '"' + feature + '" is a reserved name');
  const actions = route.actions || {};
  for (const action of Object.keys(actions)) {
    if (!IDENT.test(action)) fail(where, 'invalid action name "' + action + '"');
    if (RESERVED_ACTIONS.has(action)) fail(where, 'action "' + action + '" is a reserved name');
    const params = actions[action].params || {};
    for (const name of Object.keys(params)) {
      const t = params[name].type;
      if (t !== undefined && !TYPES.has(t)) fail(where, feature + '.' + action + '.' + name + ': unknown type "' + t + '"');
    }
  }
}

function runtimeAction(spec) {
  const params = {};
  const query = {};
  for (const name of Object.keys(spec.params || {})) {
    const p = spec.params[name];
    const out = {};
    if (p.type !== undefined && p.type !== 'any') out.type = p.type;
    if (p.required) out.required = true;
    if (p.min !== undefined) out.min = p.min;
    if (p.max !== undefined) out.max = p.max;
    params[name] = out;
    if (p.query !== false) query[p.query || name] = name;
  }
  const action = { params };
  if (spec.scheme) {
    const legacy = { scheme: spec.scheme };
    if (Object.keys(query).length) legacy.query = query;
    const watch = [].concat(spec.callback || []);
    if (watch.length) legacy.watch = watch;
    if (spec.returns) legacy.result = spec.returns;
    action.legacy = legacy;
  }
  return action;
}

function resultType(spec, where, pad) {
  if (spec.result) return tsType(spec.result, where, pad);
  const watch = [].concat(spec.callback || []);
  if (!watch.length) return 'void';
  if (spec.returns || watch.some((w) => w.indexOf('{') !== -1)) return 'unknown';
  return '{ ' + watch.map((w) => key(w) + ': unknown').join('; ') + ' }';
}

function generate(routes) {
  const seen = new Set();
  const runtime = {};
  let types = '';

  routes.forEach(({ file, route }) => {
    checkRoute(route, file);
    const feature = route.feature;
    if (seen.has(feature)) fail(file, 'feature "' + feature + '" defined twice');
    seen.add(feature);

    const actions = route.actions || {};
    const events = normaliseEvents(route.events, file);
    runtime[feature] = { actions: {}, events: Object.keys(events) };

    types += doc([route.description], '  ');
    types += '  ' + feature + ': {\n    actions: {\n';
    for (const action of Object.keys(actions)) {
      const spec = actions[action] || {};
      const where = feature + '.' + action;
      runtime[feature].actions[action] = runtimeAction(spec);
      const params = spec.params || {};
      const args = Object.keys(params).length ? objectType(params, where, '        ') : 'void';
      types += doc([spec.description], '      ');
      types += '      ' + action + ': {\n';
      types += '        args: ' + args + ';\n';
      types += '        result: ' + resultType(spec, where, '        ') + ';\n';
      types += '      };\n';
    }
    const eventNames = Object.keys(events);
    types += eventNames.length ? '    };\n    events: {\n' : '    };\n    events: {};\n';
    for (const event of eventNames) {
      const spec = events[event] || {};
      types += doc([spec.description], '      ');
      types += '      ' + key(event) + ': ' + tsType(spec.data, feature + ':' + event, '      ') + ';\n';
    }
    types += eventNames.length ? '    };\n  };\n' : '  };\n';
  });

  const dts = [
    '// features.d.ts - typed feature map for the Despia JSON bridge.',
    '// Generated by scripts/generate-features.js from routes.json. Do not edit.',
    '',
    'export interface DespiaFeatureMap {',
    types.replace(/\n$/, ''),
    '}',
    ''
  ].join('\n');

  const js = [
    "'use strict';",
    '',
    '// Runtime feature map. Generated by scripts/generate-features.js from',
    '// routes.json. Do not edit; see features.d.ts for the types.',
    '',
    'module.exports = ' + JSON.stringify(runtime, null, 2) + ';',
    ''
  ].join('\n');

  return { dts, js, runtime };
}

function readRoutes(files) {
  return files.map((file) => ({ file, route: JSON.parse(fs.readFileSync(file, 'utf8')) }));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  let outDir = path.join(__dirname, '..');
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outDir = path.resolve(argv[++i]);
    else files.push(argv[i]);
  }
  if (!files.length) {
    console.error('usage: node scripts/generate-features.js [--out <dir>] <routes.json>...');
    process.exit(2);
  }
  const { dts, js } = generate(readRoutes(files));
  fs.mkdirSync(path.join(outDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'features.d.ts'), dts);
  fs.writeFileSync(path.join(outDir, 'src', 'features.js'), js);
  console.log('wrote ' + path.join(outDir, 'features.d.ts') + ' and src/features.js');
}

module.exports = { generate, readRoutes };
