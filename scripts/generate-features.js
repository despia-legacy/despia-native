#!/usr/bin/env node
'use strict';

// Generator: turns a bridge catalog into the typed feature map and the
// runtime table the SDK ships.
//
//   node scripts/generate-features.js [--out <dir>] [--check] [catalog.json ...]
//
// Reads bridge-catalog.json (default) and writes <dir>/features.d.ts and
// <dir>/src/features.js (<dir> defaults to the repository root). `--check`
// writes nothing and exits 1 when either file is out of date. Run
// `npm run build` afterwards to refresh index.js.
//
// Catalog shape:
//
// {
//   "features": {
//     "<id>": {
//       "description": "optional",
//       "assets": { "files": ["core.wasm"] },          // optional; paths are validated only
//       "actions": {
//         "<name>": {
//           "kind": "request" | "job",
//           "description": "optional",
//           "args": { "<arg>": { "type": ..., "required": true, ... } },
//           "result": { "type": ... },                  // request: the value; job: extra fields of `done`
//           "timeoutMs": 10000,
//           "job": { "events": ["progress", "log", "done"] },
//           "legacy": { "scheme", "host"?, "route"?, "variable"?, "callback"?, "answer" }
//         }
//       },
//       "events": { "<name>": { "scope", "data": { ...schema }, "callback"? } }
//     }
//   }
// }
//
// Argument kinds: string, int, number, bool, enum, https_url, array, object,
// fileRef, json. Result and event schemas also accept null and `nullable`.

const fs = require('fs');
const path = require('path');
const { jsNameOK } = require('../src/names');

const ROOT = path.join(__dirname, '..');

// Words the SDK keeps on `despia.<word>`, and names that would collide with
// the function object itself. A feature may not use any of them.
const RESERVED_FEATURES = new Set([
  'bridge', 'legacy', 'jobs', 'on', 'off', 'ready', 'version', 'call',
  'then', 'apply', 'bind', 'length', 'name', 'prototype', 'arguments', 'caller', 'constructor'
]);
const RESERVED_ACTIONS = new Set(['on', 'then', 'constructor', 'toString', 'valueOf', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toJSON']);
const FEATURE_ID = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const ACTION_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const ARG_NAME = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const EVENT_NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const SCHEME = /^[a-z][a-z0-9+.-]{0,40}$/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ARG_KINDS = new Set(['string', 'int', 'number', 'bool', 'enum', 'https_url', 'array', 'object', 'fileRef', 'json']);
const SCHEMA_KINDS = new Set([...ARG_KINDS, 'null']);
const JSON_KINDS = new Set(['array', 'object', 'fileRef', 'json']);
const ANSWERS = new Set(['envelope', 'variable', 'none']);

// Wire action names are snake_case; the SDK also exposes the camelCase
// spelling: the segment after each "_" is capitalised.
function camelCase(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function fail(where, message) {
  throw new Error(where + ': ' + message);
}

// ---- validation -----------------------------------------------------------

function checkSchema(spec, where, kinds) {
  if (!spec || typeof spec !== 'object') fail(where, 'schema must be an object');
  if (!kinds.has(spec.type)) fail(where, 'unknown type "' + spec.type + '"');
  if (spec.type === 'enum' && !(Array.isArray(spec.values) && spec.values.length)) {
    fail(where, 'enum needs a non-empty "values" list');
  }
  if (spec.type === 'array' && spec.items) checkSchema(spec.items, where + '[]', kinds);
  if (spec.type === 'object') {
    const props = spec.properties || {};
    Object.keys(props).forEach((name) => checkSchema(props[name], where + '.' + name, kinds));
  }
}

function checkAssets(assets, where) {
  if (assets === undefined) return;
  const files = assets && assets.files;
  if (!Array.isArray(files)) fail(where, '"assets.files" must be a list');
  files.forEach((file) => {
    if (typeof file !== 'string' || file === '') fail(where, 'asset path must be a non-empty string');
    if (file.indexOf('\\') !== -1 || file.charAt(0) === '/') {
      fail(where, 'asset path "' + file + '" must be relative and use "/"');
    }
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(file) && file.split('/').every((x) => x !== '.' && x !== '..' && x !== '')) {
      fail(where, 'asset path "' + file + '" may only use letters, digits, ".", "_" and "-" between "/"');
    }
    file.split('/').forEach((segment) => {
      if (segment === '.' || segment === '..' || segment === '') {
        fail(where, 'asset path "' + file + '" has a "' + segment + '" segment; "." and ".." are not allowed');
      }
    });
  });
}

function checkLegacy(legacy, where) {
  if (!legacy || typeof legacy !== 'object') fail(where, 'legacy must be an object');
  if (typeof legacy.scheme !== 'string' || !SCHEME.test(legacy.scheme)) fail(where, 'legacy.scheme is not a valid scheme');
  if (!ANSWERS.has(legacy.answer)) fail(where, 'legacy.answer must be envelope, variable or none');
  const names = [].concat(legacy.variable || []);
  names.forEach((name) => {
    if (typeof name !== 'string' || !IDENT.test(name.replace(/\{[^}]+\}/g, 'x'))) {
      fail(where, 'legacy.variable "' + name + '" is not a window variable name');
    }
    if (!/\{[^}]+\}/.test(name) && !jsNameOK(name)) {
      fail(where, 'legacy.variable "' + name + '" is a name the page or the app already uses');
    }
  });
  if (legacy.answer !== 'none' && !names.length) fail(where, 'legacy.answer "' + legacy.answer + '" needs legacy.variable');
}

function checkFeature(id, feature, file) {
  const where = (file ? file + ': ' : '') + id;
  if (!FEATURE_ID.test(id) || id.length < 2 || id.length > 32) fail(where, 'invalid feature id');
  if (RESERVED_FEATURES.has(id)) fail(where, '"' + id + '" is a reserved feature id');
  if (!feature || typeof feature !== 'object') fail(where, 'feature must be an object');
  checkAssets(feature.assets, where);
  const actions = feature.actions || {};
  const exposed = new Map(); // spelling -> action that owns it
  Object.keys(actions).forEach((name) => {
    const here = where + '.' + name;
    const action = actions[name];
    if (!ACTION_NAME.test(name)) fail(here, 'invalid action name');
    if (/__|_$/.test(name)) fail(here, 'action name must not have a trailing or doubled "_" (its camelCase form would be ambiguous)');
    if (RESERVED_ACTIONS.has(name)) fail(here, 'action name is reserved');
    [name, camelCase(name)].forEach((spelling) => {
      if (RESERVED_ACTIONS.has(spelling)) fail(here, 'its spelling "' + spelling + '" is reserved');
      const other = exposed.get(spelling);
      if (other !== undefined && other !== name) {
        fail(where, 'actions "' + other + '" and "' + name + '" both expose "' + spelling + '" in camelCase');
      }
      exposed.set(spelling, name);
    });
    if (!action || (action.kind !== 'request' && action.kind !== 'job')) fail(here, 'kind must be request or job');
    const args = action.args || {};
    Object.keys(args).forEach((arg) => {
      if (!ARG_NAME.test(arg)) fail(here, 'invalid arg name "' + arg + '"');
      checkSchema(args[arg], here + '.' + arg, ARG_KINDS);
    });
    if (action.result) checkSchema(action.result, here + ' result', SCHEMA_KINDS);
    if (action.timeoutMs !== undefined &&
        !(Number.isInteger(action.timeoutMs) && action.timeoutMs >= 100 && action.timeoutMs <= 600000)) {
      fail(here, 'timeoutMs must be an integer from 100 to 600000');
    }
    if (action.legacy) {
      checkLegacy(action.legacy, here);
      // A {name} in the variable becomes a window variable at run time, so it
      // may only name a declared string argument.
      [].concat(action.legacy.variable || []).forEach((template) => {
        (template.match(/\{[^}]+\}/g) || []).forEach((hole) => {
          const arg = args[hole.slice(1, -1)];
          if (!arg || (arg.type !== 'string' && arg.type !== 'enum')) {
            fail(here, 'legacy.variable "' + template + '" refers to ' + hole + ', which is not a declared string argument');
          }
        });
      });
    }
    if (action.kind === 'job') {
      [].concat((action.job && action.job.events) || []).forEach((event) => {
        if (!EVENT_NAME.test(event)) fail(here, 'invalid job event name "' + event + '"');
      });
    }
  });
  const events = feature.events || {};
  Object.keys(events).forEach((name) => {
    if (!EVENT_NAME.test(name)) fail(where, 'invalid event name "' + name + '"');
    if (events[name] && events[name].data) checkSchema(events[name].data, where + ':' + name, SCHEMA_KINDS);
  });
}

// ---- types ----------------------------------------------------------------

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
  const out = [];
  if (spec.type === 'string') {
    if (spec.min !== undefined) out.push('@minLength ' + spec.min);
    if (spec.max !== undefined) out.push('@maxLength ' + spec.max);
  } else if (spec.type === 'int' || spec.type === 'number') {
    if (spec.min !== undefined) out.push('@minimum ' + spec.min);
    if (spec.max !== undefined) out.push('@maximum ' + spec.max);
  } else if (spec.type === 'array') {
    if (spec.minItems !== undefined) out.push('@minItems ' + spec.minItems);
    if (spec.maxItems !== undefined) out.push('@maxItems ' + spec.maxItems);
  }
  return out.join(' ');
}

function baseType(spec, pad) {
  switch (spec.type) {
    case 'string':
    case 'https_url': return 'string';
    case 'int':
    case 'number': return 'number';
    case 'bool': return 'boolean';
    case 'null': return 'null';
    case 'fileRef': return 'FileRef';
    case 'json': return 'unknown';
    case 'enum': return spec.values.map((v) => JSON.stringify(v)).join(' | ');
    case 'array': {
      const item = tsType(spec.items, pad);
      return /^[\w.]+$/.test(item) ? item + '[]' : 'Array<' + item + '>';
    }
    case 'object': {
      const props = spec.properties || {};
      if (!Object.keys(props).length) return spec.additionalProperties === true || !spec.properties
        ? 'Record<string, unknown>' : '{}';
      return objectType(props, pad, spec.additionalProperties === true);
    }
  }
  return 'unknown';
}

function tsType(spec, pad) {
  if (!spec) return 'unknown';
  const type = baseType(spec, pad);
  if (!spec.nullable || spec.type === 'null') return type;
  return (type.indexOf(' | ') !== -1 ? '(' + type + ')' : type) + ' | null';
}

function objectType(props, pad, open) {
  const inner = pad + '  ';
  let out = '{\n';
  Object.keys(props).forEach((name) => {
    const p = props[name];
    out += doc([[p.description, rangeDoc(p)].filter(Boolean).join(' ')], inner);
    out += inner + key(name) + (p.required ? '' : '?') + ': ' + tsType(p, inner) + ';\n';
  });
  if (open) out += inner + '[key: string]: unknown;\n';
  return out + pad + '}';
}

function argsType(args, pad) {
  return Object.keys(args || {}).length ? objectType(args, pad, false) : 'void';
}

// Job events carry the job id the bridge stamps into their data.
function withJobId(schema, pad) {
  const jobId = { type: 'string', required: true };
  if (!schema) return '{\n' + pad + '  jobId: string;\n' + pad + '  [key: string]: unknown;\n' + pad + '}';
  if (schema.type === 'object') {
    const props = Object.assign({}, schema.properties || {});
    if (!props.jobId) {
      return tsType(Object.assign({}, schema, { properties: Object.assign({ jobId }, props), nullable: false }), pad);
    }
    return tsType(schema, pad);
  }
  return tsType(schema, pad) + ' & { jobId: string }';
}

function jobEvents(action) {
  const listed = action.job && action.job.events;
  return Array.isArray(listed) && listed.length ? listed : ['progress', 'log', 'done'];
}

function doneType(action, events, pad) {
  const declared = events.done && events.done.data;
  if (declared) return 'JobDone & ' + withJobId(declared, pad);
  if (action.result) return 'JobDone & ' + tsType(action.result, pad);
  return 'JobDone';
}

function actionType(action, events, pad) {
  const inner = pad + '  ';
  let out = '{\n';
  out += inner + "kind: '" + action.kind + "';\n";
  out += inner + 'args: ' + argsType(action.args, inner) + ';\n';
  if (action.kind === 'job') {
    out += inner + 'result: ' + doneType(action, events, inner) + ';\n';
    out += inner + 'events: {\n';
    jobEvents(action).filter((e) => e !== 'done').forEach((event) => {
      const spec = events[event] || {};
      out += inner + '  ' + key(event) + ': ' + withJobId(spec.data, inner + '  ') + ';\n';
    });
    out += inner + '};\n';
  } else {
    out += inner + 'result: ' + (action.result ? tsType(action.result, inner) : 'void') + ';\n';
  }
  return out + pad + '}';
}

function featureTypes(id, feature) {
  const actions = feature.actions || {};
  const events = feature.events || {};
  const inJob = new Set();
  Object.keys(actions).forEach((name) => {
    if (actions[name].kind === 'job') jobEvents(actions[name]).forEach((e) => inJob.add(e));
  });

  let out = doc([feature.description], '  ');
  out += '  ' + key(id) + ': {\n    actions: {\n';
  Object.keys(actions).forEach((name) => {
    const action = actions[name];
    const camel = camelCase(name);
    const body = actionType(action, events, '      ');
    if (camel !== name) {
      out += doc([action.description, 'Wire name: `' + name + '`.'], '      ');
      out += '      ' + key(camel) + ': ' + body + ';\n';
      out += doc(['Same as `' + camel + '`.'], '      ');
    } else {
      out += doc([action.description], '      ');
    }
    out += '      ' + key(name) + ': ' + body + ';\n';
  });
  out += '    };\n';
  if (!Object.keys(events).length) return out + '    events: {};\n  };\n';
  out += '    events: {\n';
  Object.keys(events).forEach((name) => {
    const spec = events[name] || {};
    out += doc([spec.description], '      ');
    let type;
    if (name === 'done' && inJob.has('done')) {
      type = 'JobDone & ' + (spec.data ? withJobId(spec.data, '      ') : '{}');
    } else if (inJob.has(name)) {
      type = withJobId(spec.data, '      ');
    } else {
      type = spec.data ? tsType(spec.data, '      ') : 'Record<string, unknown>';
    }
    out += '      ' + key(name) + ': ' + type + ';\n';
  });
  out += '    };\n  };\n';
  return out;
}

// ---- runtime table ---------------------------------------------------------

function runtimeLegacy(action) {
  const legacy = action.legacy;
  const out = { scheme: legacy.scheme };
  if (legacy.host) out.host = legacy.host;
  if (legacy.route) out.route = legacy.route;
  out.args = Object.keys(action.args || {}).map((arg) => {
    const spec = action.args[arg];
    const l = spec.legacy || {};
    return {
      arg,
      name: l.name || arg,
      encoding: l.encoding || (JSON_KINDS.has(spec.type) ? 'json' : 'plain')
    };
  });
  if (legacy.variable) out.variable = legacy.variable;
  if (legacy.callback) out.callback = legacy.callback;
  out.answer = legacy.answer;
  return out;
}

function runtimeFeature(feature) {
  const actions = {};
  Object.keys(feature.actions || {}).forEach((name) => {
    const action = feature.actions[name];
    const out = { kind: action.kind };
    if (camelCase(name) !== name) out.alias = camelCase(name);
    if (action.timeoutMs !== undefined) out.timeoutMs = action.timeoutMs;
    if (action.kind === 'job') out.events = jobEvents(action);
    if (action.legacy) out.legacy = runtimeLegacy(action);
    actions[name] = out;
  });
  return { actions, events: Object.keys(feature.events || {}) };
}

// ---- generate --------------------------------------------------------------

// sources: [{ file, catalog }]. Returns { dts, js, runtime }.
function generate(sources) {
  const seen = new Set();
  const runtime = {};
  let types = '';
  let usesFileRef = false;

  sources.forEach(({ file, catalog }) => {
    if (!catalog || typeof catalog !== 'object' || typeof catalog.features !== 'object' || catalog.features === null) {
      fail(file || 'catalog', 'missing "features" object');
    }
    Object.keys(catalog.features).forEach((id) => {
      const feature = catalog.features[id];
      checkFeature(id, feature, file);
      if (seen.has(id)) fail(file || 'catalog', 'feature "' + id + '" defined twice');
      seen.add(id);
      runtime[id] = runtimeFeature(feature);
      types += featureTypes(id, feature);
    });
  });
  usesFileRef = /\bFileRef\b/.test(types);

  const dts = [
    '// features.d.ts - typed feature map for the Despia JSON bridge.',
    '// Generated by scripts/generate-features.js from bridge-catalog.json. Do not edit.',
    '',
    "import type { " + (usesFileRef ? 'FileRef, ' : '') + "JobDone } from './index';",
    '',
    'export interface DespiaFeatureMap {',
    types.replace(/\n$/, ''),
    '}',
    ''
  ].join('\n');

  const js = [
    "'use strict';",
    '',
    '// Runtime feature table. Generated by scripts/generate-features.js from',
    '// bridge-catalog.json. Do not edit; see features.d.ts for the types.',
    '',
    'module.exports = ' + JSON.stringify(runtime, null, 2) + ';',
    ''
  ].join('\n');

  return { dts, js, runtime };
}

function readCatalogs(files) {
  return files.map((file) => ({ file, catalog: JSON.parse(fs.readFileSync(file, 'utf8')) }));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  let outDir = ROOT;
  let check = false;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outDir = path.resolve(argv[++i]);
    else if (argv[i] === '--check') check = true;
    else files.push(argv[i]);
  }
  if (!files.length) files.push(path.join(ROOT, 'bridge-catalog.json'));
  let result;
  try {
    result = generate(readCatalogs(files));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const targets = [
    [path.join(outDir, 'features.d.ts'), result.dts],
    [path.join(outDir, 'src', 'features.js'), result.js]
  ];
  if (check) {
    const stale = targets.filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text);
    if (stale.length) {
      console.error('out of date: ' + stale.map(([file]) => path.relative(outDir, file)).join(', ') + ' (run `npm run generate`)');
      process.exit(1);
    }
    console.log('features.d.ts and src/features.js are up to date');
  } else {
    fs.mkdirSync(path.join(outDir, 'src'), { recursive: true });
    targets.forEach(([file, text]) => fs.writeFileSync(file, text));
    console.log('wrote features.d.ts and src/features.js');
  }
}

module.exports = { generate, readCatalogs, camelCase, RESERVED_FEATURES };
