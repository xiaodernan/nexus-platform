#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/check_internal_proxy_launch_paths.mjs';
const FLAGS = {
  '--self-test': { kind: 'switch' },
  '--report': { kind: 'switch' },
  '--verbose': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) {
  console.log(`RESULT: NOT CHECKED — ${parsed.reason}`);
  process.exit(2);
}

const REQUIRED_ANCHORS = [
  'package.json',
  'apps/web/package.json',
  'apps/ai/Dockerfile',
  'apps/ai/start_ai.py',
  'services/platform/Dockerfile',
  'services/platform/src/main/resources/application.yml',
  '.github/workflows/ci.yml',
  'Makefile',
];
const SCOPE_PROBES = [
  'packages/sdk/package.json',
  'packages/types/package.json',
  'tests/e2e/package.json',
  'tests/e2e/playwright.config.ts',
  'apps/web/scripts/collect-evidence.mjs',
];
const LAUNCH_PATTERNS = [
  /(^|\/)package\.json$/,
  /(^|\/)Dockerfile(?:\.[^/]+)?$/,
  /(^|\/)pom\.xml$/,
  /(^|\/)src\/main\/resources\//,
  /(^|\/)(?:next|vite|playwright)\.config\.[^/]+$/,
  /(^|\/)start_[^/]+\.py$/,
  /(^|\/)(?:Makefile|[^/]+\.(?:sh|bat|cmd|ps1))$/,
  /^infra\/config\//,
  /(^|\/)(?:docker-)?compose[^/]*\.ya?ml$/,
  /^\.github\/workflows\//,
  /^scripts\//,
  /^(?:apps|tests|services|packages)\/[^/]+\/scripts\//,
];
const RULES = [
  {
    name: 'Node environment opt-in',
    pattern: /(?<![\w'.])NODE_USE_ENV_PROXY\s*(?::=|=)\s*(?:1|["']1["'])(?=$|[\s;&|),\]}])/g,
  },
  {
    name: 'Node YAML environment opt-in',
    pattern: /(?<![\w'.])NODE_USE_ENV_PROXY\s*:\s*(?:1|["']1["'])(?=$|[\s,#\]}])/g,
  },
  {
    name: 'Node YAML environment opt-in',
    pattern: /["']NODE_USE_ENV_PROXY["']\s*:\s*(?:1|["']1["'])(?=$|[\s,#\]}])/g,
  },
  {
    name: 'Node environment opt-in',
    pattern: /\bENV\s+NODE_USE_ENV_PROXY\s+1(?=$|[\s"'])/g,
  },
  {
    name: 'Node process environment opt-in',
    pattern: /\bprocess\.env(?:\.NODE_USE_ENV_PROXY|\[["']NODE_USE_ENV_PROXY["']\])\s*(?:=|\|\|=|\?\?=)\s*(?:1|["']1["'])(?=$|[\s;),\]}])/g,
  },
  {
    name: 'Python environment opt-in',
    pattern: /\bos\.environ\[["']NODE_USE_ENV_PROXY["']\]\s*=\s*(?:1|["']1["'])(?=$|[\s;),\]}])/g,
  },
  {
    name: 'Node CLI proxy opt-in',
    pattern: /(?<![\w/-])--use-env-proxy(?![A-Za-z0-9_-])/g,
  },
  {
    name: 'JVM proxy host',
    pattern: /(?<![\w])-Dhttps?\.proxyHost=[^\s"';&|]+/g,
  },
  {
    name: 'JVM system proxies',
    pattern: /(?<![\w])-Djava\.net\.useSystemProxies(?:=[Tt][Rr][Uu][Ee])?(?=$|[\s"';,&|<>])/g,
  },
  {
    name: 'Node environment opt-in',
    pattern: /<NODE_USE_ENV_PROXY>\s*1\s*<\/NODE_USE_ENV_PROXY>/g,
  },
  {
    name: 'JAVA_TOOL_OPTIONS passthrough',
    pattern: /(?:^[ \t]*(?:-[ \t]+)?(?:export[ \t]+|env[ \t]+|ENV[ \t]+)?|[;&|]\s*(?:export[ \t]+|env[ \t]+)?)JAVA_TOOL_OPTIONS\s*[:=]\s*[^\n]*\bJAVA_TOOL_OPTIONS\b/gm,
  },
  {
    name: 'JAVA_TOOL_OPTIONS Docker passthrough',
    pattern: /(?:^[ \t]*(?:ENV[ \t]+)?|[;&|]\s*)JAVA_TOOL_OPTIONS\s+\$\{?JAVA_TOOL_OPTIONS\b/gm,
  },
  {
    name: 'JDK_JAVA_OPTIONS passthrough',
    pattern: /(?:^[ \t]*(?:-[ \t]+)?(?:export[ \t]+|env[ \t]+|ENV[ \t]+)?|[;&|]\s*(?:export[ \t]+|env[ \t]+)?)JDK_JAVA_OPTIONS\s*[:=]\s*[^\n]*\bJDK_JAVA_OPTIONS\b/gm,
  },
  {
    name: 'JDK_JAVA_OPTIONS Docker passthrough',
    pattern: /(?:^[ \t]*(?:ENV[ \t]+)?|[;&|]\s*)JDK_JAVA_OPTIONS\s+\$\{?JDK_JAVA_OPTIONS\b/gm,
  },
  {
    name: 'JVM option environment passthrough',
    pattern: /^\s*-\s*["']?(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS)["']?\s*$/gm,
  },
  {
    name: 'JVM option environment passthrough',
    pattern: /<name>\s*(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS)\s*<\/name>\s*<value>\s*\$\{?(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS)\b/g,
  },
];

function selectLaunchPaths(tracked) {
  return [...new Set(tracked
    .map((path) => path.replace(/\\/g, '/'))
    .filter((path) => path && path !== SELF && LAUNCH_PATTERNS.some((pattern) => pattern.test(path))))]
    .sort();
}

function kindFor(path) {
  if (/(^|\/)Dockerfile(?:\.[^/]+)?$/.test(path)) return 'docker';
  if (/\.ps1$/.test(path)) return 'powershell';
  if (/(?:^|\/)(?:pom\.xml|[^/]+\.xml)$/.test(path)) return 'xml';
  if (/\.[cm]?js$|\.[cm]?tsx?$/.test(path)) return 'javascript';
  if (/\.py$/.test(path)) return 'python';
  if (/\.ya?ml$/.test(path)) return 'yaml';
  if (/\.(?:bat|cmd)$/.test(path)) return 'batch';
  if (/(?:^|\/)(?:Makefile|[^/]+\.(?:sh|bash|zsh))$/.test(path)) return 'shell';
  return 'plain';
}

function blank(text) {
  return text.replace(/[^\r\n]/g, ' ');
}

function regexMayStart(text, index) {
  const before = text.slice(0, index).trimEnd();
  if (!before) return true;
  if ('=(:,[!&|?{};'.includes(before.at(-1)) || before.endsWith('=>')) return true;
  if (/\b(?:if|while|for|with)\s*\([^)]*\)\s*$/.test(before)) return true;
  return /\b(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await)$/.test(before);
}

function stripComments(text, kind) {
  if (kind === 'xml') return text.replace(/<!--[\s\S]*?-->/g, blank);
  if (kind === 'batch') text = text.replace(/^[ \t]*(?:@?rem\b|::).*$/gim, blank);
  let out = '';
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (c === '\n') {
        out += c;
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      const closes = kind === 'powershell' ? c === '#' && next === '>' : c === '*' && next === '/';
      if (closes) {
        blockComment = false;
        i += 1;
      } else if (c === '\n') {
        out += c;
      }
      continue;
    }
    if (quote) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\' && !(quote === "'" && ['shell', 'batch', 'yaml'].includes(kind))) escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    if (c === '\\' && next !== undefined) {
      out += c + next;
      i += 1;
      continue;
    }
    const previous = text[i - 1] ?? '';
    const hashComment = c === '#' && (kind === 'docker'
      ? text.slice(0, i).trim() === ''
      : i === 0 || /\s/.test(previous) || ';&|('.includes(previous));
    const slashComment = kind === 'javascript' && c === '/' && next === '/'
      && (i === 0 || /\s/.test(previous) || ';{}'.includes(previous));
    if (kind === 'javascript' && c === '/' && next !== '/' && next !== '*'
        && regexMayStart(text, i)) {
      let close = i + 1;
      let inClass = false;
      let regexEscaped = false;
      for (; close < text.length; close += 1) {
        const rc = text[close];
        if (regexEscaped) regexEscaped = false;
        else if (rc === '\\') regexEscaped = true;
        else if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) break;
        else if (rc === '\n') break;
      }
      if (close < text.length && text[close] === '/') {
        out += `/${blank(text.slice(i + 1, close))}/`;
        i = close;
        continue;
      }
    }
    const blockOpens = (kind === 'javascript' && c === '/' && next === '*')
      || (kind === 'powershell' && c === '<' && next === '#');
    if (hashComment || slashComment) {
      lineComment = true;
      continue;
    }
    if (blockOpens) {
      blockComment = true;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

function yamlQuoteMayStart(code, index) {
  const before = code.slice(code.lastIndexOf('\n', index - 1) + 1, index).trim();
  return !before || ':,['.includes(before.at(-1)) || /^-\s*$/.test(before);
}

function stringStartAt(code, index, kind) {
  if (kind === 'xml' || kind === 'plain') return null;
  let quote = null;
  let start = -1;
  let escaped = false;
  for (let i = 0; i < index; i += 1) {
    const c = code[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\' && !(quote === "'" && ['shell', 'batch', 'yaml'].includes(kind))) escaped = true;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      if (kind === 'yaml' && !yamlQuoteMayStart(code, i)) continue;
      quote = c;
      start = i;
    }
  }
  return quote ? start : null;
}

function activeStringContext(code, start) {
  const lineStart = code.lastIndexOf('\n', start - 1) + 1;
  const before = code.slice(lineStart, start);
  if (/^\s*(?:CMD|ENTRYPOINT|RUN)\b/.test(before)
      || /\b(?:run|cmd|command|entrypoint|args?)\s*:\s*(?:\[[^\]]*)?$/.test(before)
      || /\benvironment\s*:\s*\[$/.test(before)
      || /\b(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|NODE_USE_ENV_PROXY)\s*=\s*$/.test(before)
      || /\b(?:spawn|exec|execFile|spawnSync|execFileSync|execa)\s*\(/.test(before)
      || /\b(?:java|node|npm|pnpm|yarn|env|exec|bash|sh|cmd|powershell|pwsh)\b[^"'`]*$/.test(before)) {
    return true;
  }
  const indent = (before.match(/^\s*/) ?? [''])[0].length;
  const prior = code.slice(0, lineStart).split('\n');
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const line = prior[i];
    if (!line.trim()) continue;
    const priorIndent = (line.match(/^\s*/) ?? [''])[0].length;
    if (priorIndent < indent) {
      return /^\s*(?:run|cmd|command|entrypoint|args?|environment)\s*:/.test(line);
    }
  }
  return false;
}

function scanCode(path, code, kind, script = null) {
  const hits = [];
  for (const rule of RULES) {
    for (const match of code.matchAll(rule.pattern)) {
      const index = match.index;
      const stringStart = stringStartAt(code, index, kind);
      if (stringStart !== null && !activeStringContext(code, stringStart)) continue;
      if (kind === 'yaml' && rule.name === 'JVM option environment passthrough' && /^\s*-/.test(match[0])) {
        const dash = index + match[0].indexOf('-');
        if (!activeStringContext(code, dash)) continue;
      }
      const before = code.slice(0, index);
      const line = before.split('\n').length;
      const column = index - before.lastIndexOf('\n');
      hits.push({ path, line, column, rule: rule.name, token: match[0], script });
    }
  }
  return hits;
}

function scanXml(path, text) {
  const cleaned = stripComments(text, 'xml');
  let code = blank(cleaned);
  const active = /<(argLine|jvmArg|jvmArguments|commandlineArgs|environment|environmentVariables|systemProperty|systemPropertyVariables|property)\b[^>]*>[\s\S]*?<\/\1>/gi;
  for (const match of cleaned.matchAll(active)) {
    code = code.slice(0, match.index) + match[0] + code.slice(match.index + match[0].length);
  }
  return scanCode(path, code, 'xml');
}

function scanText(path, text, kind = kindFor(path), script = null) {
  if (kind === 'xml') return scanXml(path, text);
  return scanCode(path, stripComments(text, kind), kind, script);
}

function scanPackageJson(path, text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    return [{ path, line: 1, column: 1, rule: 'package manifest parse failure', token: error.message, script: null }];
  }
  if (!manifest.scripts || typeof manifest.scripts !== 'object') return [];
  return Object.entries(manifest.scripts)
    .filter(([, command]) => typeof command === 'string')
    .flatMap(([name, command]) => scanText(path, command, 'shell', name));
}

function judge(files) {
  return files.flatMap(({ path, text }) => path.endsWith('package.json')
    ? scanPackageJson(path, text)
    : scanText(path, text));
}

function runSelfTest(tracked, selected) {
  for (const path of REQUIRED_ANCHORS) assert(selected.includes(path), `selector lost required anchor ${path}`);
  for (const path of SCOPE_PROBES) assert(selected.includes(path), `selector lost launch surface ${path}`);
  assert(!selected.includes(SELF), 'the reader must not scan its own rule table as a launch surface');
  assert(selectLaunchPaths(['apps/web/src/lib/example.ts']).length === 0,
    'ordinary application source is outside the launch/configuration plane');

  for (const path of ['docker-compose.yml', 'services/cloud/compose.yml', 'apps/ai/scripts/launch.mjs',
    'tests/e2e/scripts/launch.mjs']) {
    assert(selectLaunchPaths([path]).includes(path), `selector lost synthetic launch surface ${path}`);
  }

  const arms = [
    ['package.json', JSON.stringify({ scripts: { start: 'NODE_USE_ENV_PROXY=1 node server.js' } }), ['Node environment opt-in']],
    ['ci.yml', 'NODE_USE_ENV_PROXY: "1"', ['Node YAML environment opt-in']],
    ['ci.yml', "'NODE_USE_ENV_PROXY': '1'", ['Node YAML environment opt-in']],
    ['Dockerfile', 'ENV NODE_USE_ENV_PROXY 1', ['Node environment opt-in']],
    ['Makefile', 'export NODE_USE_ENV_PROXY := 1', ['Node environment opt-in']],
    ['launch.mjs', "const quote = /'/;\nprocess.env.NODE_USE_ENV_PROXY = '1';", ['Node process environment opt-in']],
    ['launch.mjs', "if (ready) /'/.test(text);\nprocess.env.NODE_USE_ENV_PROXY = '1';", ['Node process environment opt-in']],
    ['launch.mjs', "process.env.NODE_USE_ENV_PROXY ||= '1';", ['Node process environment opt-in']],
    ['launch.mjs', "process.env.NODE_USE_ENV_PROXY ??= '1';", ['Node process environment opt-in']],
    ['launch.sh', "echo '\\'; NODE_USE_ENV_PROXY=1 node app.js", ['Node environment opt-in']],
    ['launch.mjs', "process.env.NODE_USE_ENV_PROXY = '1';", ['Node process environment opt-in']],
    ['launch.py', "os.environ['NODE_USE_ENV_PROXY'] = '1'", ['Python environment opt-in']],
    ['launch.mjs', 'node --use-env-proxy server.js', ['Node CLI proxy opt-in']],
    ['launch.mjs', 'node --use-env-proxy=false server.js', ['Node CLI proxy opt-in']],
    ['launch.mjs', 'node "--use-env-proxy" server.js', ['Node CLI proxy opt-in']],
    ['Dockerfile', 'ENV JAVA_TOOL_OPTIONS=-Dhttp.proxyHost=127.0.0.1', ['JVM proxy host']],
    ['Dockerfile', 'ENV JAVA_TOOL_OPTIONS="-Dhttp.proxyHost=127.0.0.1"', ['JVM proxy host']],
    ['launch.sh', 'java -Dhttps.proxyHost=proxy.invalid -jar app.jar', ['JVM proxy host']],
    ['launch.sh', 'java "-Dhttp.proxyHost=proxy.invalid" -jar app.jar', ['JVM proxy host']],
    ['application.yml', '-Djava.net.useSystemProxies=true', ['JVM system proxies']],
    ['pom.xml', '<argLine>-Djava.net.useSystemProxies=true</argLine>', ['JVM system proxies']],
    ['pom.xml', '<jvmArguments>-Djava.net.useSystemProxies=true</jvmArguments>', ['JVM system proxies']],
    ['pom.xml', '<environmentVariables><NODE_USE_ENV_PROXY>1</NODE_USE_ENV_PROXY></environmentVariables>',
      ['Node environment opt-in']],
    ['pom.xml', '<description>Documents --use-env-proxy behavior</description>', []],
    ['pom.xml', '<environment><name>JAVA_TOOL_OPTIONS</name><value>${JAVA_TOOL_OPTIONS}</value></environment>',
      ['JVM option environment passthrough']],
    ['compose.yml', 'command: ["node", "--use-env-proxy", "server.js"]', ['Node CLI proxy opt-in']],
    ['compose.yml', 'args: >-\n  "-Djava.net.useSystemProxies=true"', ['JVM system proxies']],
    ['compose.yml', 'command: [\n  "node",\n  "--use-env-proxy"\n]', ['Node CLI proxy opt-in']],
    ['ci.yml', 'JAVA_TOOL_OPTIONS: ${JAVA_TOOL_OPTIONS}', ['JAVA_TOOL_OPTIONS passthrough']],
    ['ci.yml', 'JDK_JAVA_OPTIONS: ${{ env.JDK_JAVA_OPTIONS }}', ['JDK_JAVA_OPTIONS passthrough']],
    ['Dockerfile', 'ENV JAVA_TOOL_OPTIONS $JAVA_TOOL_OPTIONS', ['JAVA_TOOL_OPTIONS Docker passthrough']],
    ['compose.yml', 'environment:\n  JAVA_TOOL_OPTIONS:', []],
    ['compose.yml', 'environment: { JAVA_TOOL_OPTIONS: null }', []],
    ['compose.yml', 'notes:\n  - "--use-env-proxy is forbidden"', []],
    ['compose.yml', 'notes:\n  - "JAVA_TOOL_OPTIONS"', []],
    ['ci.yml', 'note: JAVA_TOOL_OPTIONS=${JAVA_TOOL_OPTIONS}', []],
    ['compose.yml', 'environment:\n  - JDK_JAVA_OPTIONS', ['JVM option environment passthrough']],
    ['compose.yml', 'environment:\n  - "JAVA_TOOL_OPTIONS"', ['JVM option environment passthrough']],
    ['package.json', JSON.stringify({ scripts: { start: 'NODE_USE_ENV_PROXY=0 node server.js' } }), []],
    ['package.json', JSON.stringify({ scripts: { start: 'NODE_USE_ENV_PROXY=false node server.js' } }), []],
    ['package.json', JSON.stringify({ scripts: { start: 'NODE_USE_ENV_PROXY=true node server.js' } }), []],
    ['package.json', JSON.stringify({ note: 'NODE_USE_ENV_PROXY=1', scripts: {} }), []],
    ['package.json', JSON.stringify({ scripts: { start: 'echo "NODE_USE_ENV_PROXY=1"' } }), []],
    ['package.json', '{broken', ['package manifest parse failure']],
    ['Dockerfile', 'ENV NODE_USE_ENV_PROXY=0', []],
    ['launch.sh', 'node_use_env_proxy=1 node server.js', []],
    ['launch.mjs', 'node --USE-ENV-PROXY server.js', []],
    ['application.yml', '-Djava.net.useSystemProxies=false', []],
    ['launch.sh', 'java -Dhttp.proxyHost= -jar app.jar', []],
    ['launch.sh', '# NODE_USE_ENV_PROXY=1 node server.js', []],
    ['launch.sh', 'true;# NODE_USE_ENV_PROXY=1 node server.js', []],
    ['launch.sh', 'true&&# --use-env-proxy', []],
    ['launch.cmd', 'REM --use-env-proxy', []],
    ['launch.cmd', ':: NODE_USE_ENV_PROXY=1', []],
    ['ci.yml', "description: owner's proxy notes\nrun: node --use-env-proxy", ['Node CLI proxy opt-in']],
    ['launch.sh', 'echo /*; NODE_USE_ENV_PROXY=1 node server.js', ['Node environment opt-in']],
    ['launch.mjs', 'const ok = true; // --use-env-proxy', []],
    ['launch.mjs', '/* -Dhttp.proxyHost=proxy.invalid */', []],
    ['pom.xml', '<!-- -Dhttp.proxyHost=proxy.invalid -->', []],
    ['launch.mjs', 'const note = "NODE_USE_ENV_PROXY=1";', []],
    ['launch.mjs', "const note = '--use-env-proxy';", []],
    ['launch.mjs', 'const note = "run node --use-env-proxy";', []],
    ['launch.mjs', 'const proxy = new Proxy(target, handler);', []],
  ];
  for (const [path, text, expected] of arms) {
    const actual = [...new Set(judge([{ path, text }]).map((hit) => hit.rule))].sort();
    assert.deepEqual(actual, [...expected].sort(), `${path}: ${text}`);
  }
  return arms.length;
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = output.split('\0').filter(Boolean);
  if (files.length === 0) throw new Error('git ls-files returned no tracked files');
  return files;
}

let tracked;
try {
  tracked = trackedFiles();
} catch (error) {
  console.log(`RESULT: NOT CHECKED — cannot read the tracked-file population (${error.message}). `
    + 'A launch census that cannot see Git has not cleared anything.');
  process.exit(2);
}
const selected = selectLaunchPaths(tracked);
if (selected.length === 0) {
  console.log('RESULT: NOT CHECKED — the tracked-file selector chose no launch/configuration surface.');
  process.exit(2);
}

if (parsed.flag['--self-test']) {
  try {
    const arms = runSelfTest(tracked, selected);
    console.log(`RESULT: PASS — ${arms} in-memory arms and the real Git selector agree`);
    console.log(`  tracked files ${tracked.length}; launch files ${selected.length}; scope probes ${SCOPE_PROBES.length}`);
  } catch (error) {
    console.log(`RESULT: FAIL — the proxy launch gate's self-test broke: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const files = [];
for (const path of selected) {
  try {
    files.push({ path, text: readFileSync(resolve(ROOT, path), 'utf8') });
  } catch (error) {
    console.log(`RESULT: NOT CHECKED — cannot read selected launch file ${path} (${error.code ?? error.message}). `
      + 'An unreadable member is not a member with no proxy opt-in.');
    process.exit(2);
  }
}
const hits = judge(files);
const missing = REQUIRED_ANCHORS.filter((path) => !selected.includes(path));
console.log('NEXUS D1553 — tracked launch/configuration surfaces do not opt into ambient proxy routing');
console.log(`  tracked files ${tracked.length}`);
console.log(`  launch files ${selected.length}`);
console.log(`  required anchors ${REQUIRED_ANCHORS.length - missing.length} of ${REQUIRED_ANCHORS.length}`);
console.log(`  activation hits ${hits.length}`);
if (parsed.flag['--verbose']) {
  for (const path of selected) console.log(`  ${path}`);
}
for (const hit of hits) {
  const script = hit.script ? ` [scripts.${hit.script}]` : '';
  console.log(`  ${hit.path}:${hit.line}:${hit.column} ${hit.rule}: ${hit.token}${script}`);
}
for (const path of missing) console.log(`  MISSING ANCHOR: ${path}`);
console.log('LIMIT: Git chooses tracked paths and this gate reads their working-tree bytes; CI reads a clean checkout. '
  + 'It cannot neutralize a caller\'s ambient environment.');
if (hits.length > 0 || missing.length > 0) {
  console.log(`RESULT: ${parsed.flag['--report'] ? 'REPORT' : 'FAIL'} — ${hits.length} activation hit(s), ${missing.length} missing anchor(s)`);
  process.exit(parsed.flag['--report'] ? 0 : 1);
}
console.log('RESULT: PASS — no tracked launch/configuration file on disk contains a Node/JVM proxy opt-in');
