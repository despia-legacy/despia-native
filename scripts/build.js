#!/usr/bin/env node
'use strict';

// Bundles src/*.js (CommonJS) into the single UMD file index.js that npm and
// the CDN ship. No dependencies. `node scripts/build.js --check` exits 1 if
// index.js is out of date.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'index.js');
const ENTRY = 'index';

function moduleIds() {
  return fs.readdirSync(SRC)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
    .sort((a, b) => (a === ENTRY) - (b === ENTRY) || a.localeCompare(b));
}

function indent(text, pad) {
  return text.split('\n').map((line) => (line.length ? pad + line : line)).join('\n');
}

// overrides: { <module id>: source text } replaces a module (tests use it to
// bundle a different feature table).
function build(overrides = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const modules = moduleIds().map((id) => {
    const source = (overrides[id] !== undefined ? overrides[id] : fs.readFileSync(path.join(SRC, id + '.js'), 'utf8'))
      .replace(/^'use strict';\n+/, '')
      .replace(/\s+$/, '');
    return [
      `  // ---- src/${id}.js ----`,
      `  __modules['./${id}'] = function (module, exports, require) {`,
      indent(source, '    '),
      '  };',
      ''
    ].join('\n');
  });

  return [
    `// index.js - despia-native ${pkg.version}`,
    '// Generated from src/ by scripts/build.js. Edit src/, then run `npm run build`.',
    '(function (root, factory) {',
    "    if (typeof define === 'function' && define.amd) {",
    '      define([], factory);',
    "    } else if (typeof module === 'object' && module.exports) {",
    '      module.exports = factory();',
    '    } else {',
    '      root.despia = factory();',
    '    }',
    "  }(typeof self !== 'undefined' ? self : this, function () {",
    "  'use strict';",
    '',
    '  var __modules = {};',
    '  var __cache = {};',
    '  function __require(id) {',
    '    if (__cache[id]) return __cache[id].exports;',
    '    var module = (__cache[id] = { exports: {} });',
    '    __modules[id](module, module.exports, __require);',
    '    return module.exports;',
    '  }',
    '',
    ...modules,
    `  return __require('./${ENTRY}');`,
    '}));',
    ''
  ].join('\n');
}

if (require.main === module) {
  const output = build();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== output) {
      console.error('index.js is out of date: run `npm run build`');
      process.exit(1);
    }
    console.log('index.js is up to date');
  } else {
    fs.writeFileSync(OUT, output);
    console.log('wrote index.js');
  }
}

module.exports = { build };
