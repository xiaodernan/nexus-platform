#!/usr/bin/env node
/**
 * NEXUS D574 -- the client plane's multi-child slots, and whether the ReactNode-typed props
 * rendered into them can be the unkeyed child React complains about.
 *
 * WHAT IT READS. The Next app's JSX source: `apps/web/app/**`, `apps/web/src/**` and
 * `packages/ui/src/**`. From that it derives two populations:
 *
 *   THE CLIENT PLANE -- the modules carrying the `'use client'` directive, plus every module
 *   they import (transitively, resolved through relative paths, `@/...` and `@nexus/ui/...`).
 *   A module outside this plane renders on the server and is a different question, below.
 *
 *   THE SLOTS -- every JSX element whose children compile to an ARRAY. SWC emits
 *   `isStaticChildren = true` exactly when a slot's children are an array (measured against the
 *   running bundle, D574), which is exactly when a slot has two or more real children: JSX text
 *   is trimmed the way the JSX transform trims it, so whitespace on its own line is not a child.
 *   Every member of such an array is a list member, and React asks each one for a key.
 *
 * THE DEFECT. React's `validateChildKeys` marks a PLAIN element validated at the moment the
 * element enters the array, so a locally created element never draws the warning. An element
 * that crosses the RSC boundary arrives as a `React.lazy` instead, and the runtime Next
 * vendors has no lazy branch in `validateChildKeys`
 * (`next/dist/compiled/react/cjs/react-jsx-dev-runtime.development.js`): the lazy is never
 * marked, and when the reconciler resolves it the element behind it is still unvalidated, so
 * React logs `Each child in a list should have a unique "key" prop` naming the slot's owner and
 * the component the child was passed from.
 *
 * Measured on the running dev server (D574): the home page passes its rail action from the
 * server component `HomePage` into the client component `CardRail`, the action lands as a
 * bare member of `EntityRail`'s two-child header slot, and the browser console carried exactly
 * one such error -- naming `EntityRail` and `HomePage`. With the value wrapped in a keyed
 * fragment the console carries none. The same shape rendered on the SERVER does not warn: there
 * the element is a plain element created in the same pass, and the array-creation loop marks it
 * validated before the server renderer walks the array. That is why this reader is scoped to the
 * client plane, and why a node-typed prop in a server-plane module is not reported: it is not
 * this defect.
 *
 * THE RULE. In a client-plane module, a component's ReactNode-typed prop may not be a bare
 * member of a multi-child slot. The prop's type is read from the component's own declaration:
 * an inline type literal, a named interface or type alias declared in the same file (following
 * `extends`), or the type argument of `React.FC<...>`. A prop whose type the reader cannot see
 * is not reported -- see below.
 *
 * WHAT IT DOES NOT DO, stated rather than implied.
 *   - It does not decide whether a slot's prop is actually handed a server-created element. It
 *     asks the question React asks: can this shape warn? A prop that only ever receives a
 *     client-local element is reported anyway. That direction over-reports, which is the
 *     direction this project accepts.
 *   - It reads the BARE-IDENTIFIER form only. A conditional (`{action ? <X/> : null}`), a
 *     logical (`{action && <X/>}`) or an array literal is not read as a bare prop: those
 *     compile to an element the slot creates itself, and the reader says so rather than
 *     guessing.
 *   - It does not check the DUPLICATE-key warning, which React raises on the client only and
 *     which no source scan can decide -- two cards may legitimately carry the same id.
 *   - It does not run a browser. It reads the source and reasons about the shape the compiler
 *     emits; the live measurement that anchors it is D574's console A/B.
 *
 * Usage: node scripts/check_slot_keys.mjs [--plane <dir>] [--report] [--verbose]
 * Exit:  0 no slot can warn; 1 a slot can warn; 2 the census itself is not trustworthy.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseFlags } from './cli_args.mjs';

const FLAGS = {
  '--plane': { kind: 'value', unit: 'directory' },
  '--report': { kind: 'switch' },
  '--verbose': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) { console.log(`RESULT: NOT CHECKED — ${parsed.reason}`); process.exit(2); }
const REPORT_ONLY = Boolean(parsed.flag['--report']);
const VERBOSE = Boolean(parsed.flag['--verbose']);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLANE = parsed.value['--plane'] ? resolve(parsed.value['--plane']) : ROOT;
const ROOTS = ['apps/web/app', 'apps/web/src', 'packages/ui/src'];
const rel = (abs) => relative(PLANE, abs).replace(/\\/g, '/');

/* ---------------------------------------------------------------- the population */

function filesUnder(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) filesUnder(abs, out);
    else if (e.isFile() && /\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(abs);
  }
  return out;
}

const missing = ROOTS.filter((r) => !existsSync(join(PLANE, r)));
if (missing.length) {
  console.log(`RESULT: NOT CHECKED — ${missing.length} of ${ROOTS.length} source root(s) this census reads are absent: `
    + `${missing.join(', ')}. A tree this reader cannot see is not a tree whose slots are safe.`);
  process.exit(2);
}
const files = ROOTS.flatMap((r) => filesUnder(join(PLANE, r)));
if (files.length === 0) {
  console.log('RESULT: NOT CHECKED — no JSX source was read under the three roots this census reads; '
    + 'a population of zero has cleared nothing.');
  process.exit(2);
}

/* ---------------------------------------------------------------- parse once, keep the AST */

const infos = new Map();
for (const abs of files) {
  const text = readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  infos.set(abs, { abs, text, sf });
}

/** The `'use client'` directive, read as the file's FIRST statement -- where Next requires it. */
function isClientModule(sf) {
  const first = sf.statements[0];
  if (!first || !ts.isExpressionStatement(first)) return false;
  const e = first.expression;
  return ts.isStringLiteral(e) && e.text === 'use client';
}

/* ---------------------------------------------------------------- the client plane */

function resolveModule(spec, fromFile) {
  const dir = dirname(fromFile);
  let base = null;
  if (spec.startsWith('.')) base = resolve(dir, spec);
  else if (spec.startsWith('@/')) base = join(PLANE, 'apps', 'web', 'src', spec.slice(2));
  else if (spec === '@nexus/ui') base = join(PLANE, 'packages', 'ui', 'src', 'index.ts');
  else if (spec.startsWith('@nexus/ui/')) base = join(PLANE, 'packages', 'ui', 'src', spec.slice('@nexus/ui/'.length));
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try { if (existsSync(cand) && statSync(cand).isFile()) return cand; } catch { /* not this candidate */ }
  }
  return null;
}

/**
 * The module specifiers a file reaches, from the AST rather than from a regex over its text.
 *
 * RE-EXPORTS COUNT. `packages/ui/src/index.ts` is a barrel: it re-exports the package with
 * `export * from './primitives/Layout'` and the like, and it carries no `'use client'` directive
 * of its own. A client module that imports `@nexus/ui` therefore pulls the whole barrel into the
 * client bundle -- through the re-export, not through an import statement. A closure that reads
 * only `import` declarations misses every one of those modules: measured, the first version of
 * this reader put 53 modules in the client plane and `packages/ui/src/primitives/Layout.tsx` was
 * not among them, so `Section`'s two-child slot went uncensused.
 */
function importSpecifiers(sf) {
  const out = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      if (st.moduleSpecifier.text.startsWith('next/')) continue;
      out.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      if (st.moduleSpecifier.text.startsWith('next/')) continue;
      out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

const clientRoots = files.filter((abs) => isClientModule(infos.get(abs).sf));
if (clientRoots.length === 0) {
  console.log('RESULT: NOT CHECKED — no module in the population carries the `\'use client\'` directive, so the '
    + 'client plane this census is about is empty. An empty plane is not a clean plane.');
  process.exit(2);
}

const clientPlane = new Set();
{
  const queue = [...clientRoots];
  while (queue.length) {
    const abs = queue.pop();
    if (clientPlane.has(abs)) continue;
    clientPlane.add(abs);
    const info = infos.get(abs);
    if (!info) continue;
    for (const spec of importSpecifiers(info.sf)) {
      const target = resolveModule(spec, abs);
      if (target && infos.has(target)) queue.push(target);
    }
  }
}

/* ---------------------------------------------------------------- the types a component declares */

/** The node-ish type names. `ReactNode` is the one that matters; `ReactElement` and `ReactChildren` are read too. */
const NODE_TYPE = /\b(ReactNode|ReactElement|ReactChildren)\b/;

/** The interfaces and type aliases a file declares, by name. */
function localTypes(sf) {
  const map = new Map();
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st)) map.set(st.name.text, st);
    else if (ts.isTypeAliasDeclaration(st)) map.set(st.name.text, st);
  }
  return map;
}

/**
 * The members of a props type, flattened: an inline literal as it stands, an interface with the
 * members it inherits, a type alias followed to what it aliases, an intersection as all of its
 * parts. `React.FC<Props>` is the type argument.
 */
function resolveMembers(typeNode, types, seen = new Set()) {
  if (!typeNode) return [];
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.filter((m) => ts.isPropertySignature(m)).map((m) => ({
      name: m.name.getText(),
      type: m.type,
    }));
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.flatMap((t) => resolveMembers(t, types, seen));
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText();
    if (name === 'React.FC' || name === 'FC' || name === 'React.FunctionComponent' || name === 'FunctionComponent') {
      const arg = typeNode.typeArguments?.[0];
      return arg ? resolveMembers(arg, types, seen) : [];
    }
    const decl = types.get(name);
    if (!decl || seen.has(name)) return [];
    seen.add(name);
    if (ts.isInterfaceDeclaration(decl)) {
      const own = decl.members.filter((m) => ts.isPropertySignature(m)).map((m) => ({ name: m.name.getText(), type: m.type }));
      const inherited = (decl.heritageClauses ?? []).flatMap((h) => h.types).flatMap((t) => resolveMembers(t, types, seen));
      return [...inherited, ...own];
    }
    if (ts.isTypeAliasDeclaration(decl)) return resolveMembers(decl.type, types, seen);
  }
  return [];
}

/** Is THIS type a node type? An interface is not one by being a container of node-typed members. */
function isNodeType(typeNode, types, seen = new Set()) {
  if (!typeNode) return false;
  if (NODE_TYPE.test(typeNode.getText())) return true;
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some((t) => isNodeType(t, types, seen));
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText();
    const decl = types.get(name);
    if (!decl || seen.has(name)) return false;
    seen.add(name);
    if (ts.isTypeAliasDeclaration(decl)) return isNodeType(decl.type, types, seen);
  }
  return false;
}

/* ---------------------------------------------------------------- the components a file declares */

/**
 * Every component in a file, with the props type it declares and how its props are reached.
 *
 * `bindings` maps a LOCAL name to the PROPS-OBJECT key it came from, and is null when the props
 * object is named rather than destructured (`props: Props`), in which case the props object is
 * read through `owner.propsParamName`. The distinction matters: in a destructured component a
 * bare identifier in the JSX is a prop, but in a named-props component a bare identifier is a
 * LOCAL VARIABLE -- `EntityCard` computes its own `badges`, and reading that as a prop would be
 * reading a name the component invented.
 */
function componentsIn(sf) {
  const types = localTypes(sf);
  const comps = [];
  const visit = (n) => {
    let name = null;
    let fn = null;
    if (ts.isFunctionDeclaration(n) && n.name) { name = n.name.text; fn = n; }
    else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          name = d.name.text; fn = d.initializer;
        }
      }
    }
    if (name && fn) {
      const p = fn.parameters?.[0];
      let propsType = null;
      let bindings = null;
      let propsParamName = null;
      if (p && p.type) {
        propsType = p.type;
        if (ts.isObjectBindingPattern(p.name)) {
          bindings = new Map();
          for (const el of p.name.elements) {
            if (ts.isBindingElement(el)) {
              // `hrefFor: hrefOverride` -- the props-object key is `hrefFor`, the local name is `hrefOverride`.
              const key = el.propertyName ? el.propertyName.getText() : el.name.getText();
              bindings.set(el.name.getText(), key);
            } else if (ts.isShorthandPropertyAssignment(el)) {
              bindings.set(el.name.text, el.name.text);
            }
          }
        } else if (ts.isIdentifier(p.name)) {
          propsParamName = p.name.text;
        }
      }
      comps.push({ name, fn, propsType, bindings, propsParamName, types });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return comps;
}

/** The innermost component whose body contains a node. */
function ownerOf(comps, node) {
  let best = null;
  for (const c of comps) {
    if (node.pos >= c.fn.pos && node.end <= c.fn.end) {
      if (!best || (c.fn.end - c.fn.pos) < (best.fn.end - best.fn.pos)) best = c;
    }
  }
  return best;
}

/* ---------------------------------------------------------------- the slots */

/** JSX text, trimmed the way the JSX transform trims it: a line of whitespace is not a child. */
function jsxTextValue(text) {
  const lines = text.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  for (let i = 0; i < lines.length; i += 1) if (/[^ \t]/.test(lines[i])) lastNonEmpty = i;
  let out = '';
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].replace(/\t/g, ' ');
    if (i !== 0) line = line.replace(/^ +/, '');
    if (i !== lines.length - 1) line = line.replace(/ +$/, '');
    if (!line) continue;
    if (i !== lastNonEmpty) line += ' ';
    out += line;
  }
  return out;
}

const realChildren = (el) => el.children.filter((c) => !(ts.isJsxText(c) && jsxTextValue(c.text) === ''));

const offenders = [];
let slotsScanned = 0;
let propsRead = 0;

for (const abs of clientPlane) {
  const info = infos.get(abs);
  if (!info) continue;
  const { sf } = info;
  const comps = componentsIn(sf);
  const visit = (n) => {
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
      const kids = realChildren(n);
      if (kids.length >= 2) {
        slotsScanned += 1;
        const owner = ownerOf(comps, n);
        if (owner && owner.propsType) {
          const members = resolveMembers(owner.propsType, owner.types);
          for (const kid of kids) {
            if (!ts.isJsxExpression(kid) || !kid.expression) continue;
            const ex = kid.expression;
            let propName = null;
            if (owner.bindings) {
              // A destructured component: the identifier IS one of its props.
              if (!ts.isIdentifier(ex)) continue;
              propName = owner.bindings.get(ex.text) ?? null;
            } else if (owner.propsParamName) {
              // A named props object: only `props.x` names a prop; a bare identifier is a local.
              if (!ts.isPropertyAccessExpression(ex)) continue;
              if (!ts.isIdentifier(ex.expression) || ex.expression.text !== owner.propsParamName) continue;
              propName = ex.name.text;
            } else {
              continue;
            }
            if (!propName) continue;
            const member = members.find((m) => m.name === propName);
            // A prop the reader cannot see is not a node-typed prop -- EXCEPT `children`, whose type
            // usually lives in the platform's own declarations (`React.ButtonHTMLAttributes` and
            // friends), which this reader does not resolve. React's JSX contract makes every
            // component's children a ReactNode, so a slot that renders `children` bare is read
            // here as node-typed. An explicitly declared `children` still wins over this fallback.
            const nodeTyped = member ? isNodeType(member.type, owner.types) : propName === 'children';
            if (!nodeTyped) continue;
            propsRead += 1;
            const line = sf.getLineAndCharacterOfPosition(kid.getStart(sf)).line + 1;
            offenders.push({
              file: rel(abs), line,
              component: owner.name, prop: propName,
              slot: n.openingElement ? n.openingElement.tagName.getText(sf) : '(fragment)',
              size: kids.length,
            });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/* ---------------------------------------------------------------- the verdict */

const serverOnly = files.length - clientPlane.size;
console.log('NEXUS — the client plane\'s multi-child slots, and the ReactNode-typed props rendered into them');
console.log(`  plane read            ${PLANE}`);
console.log(`  population            ${files.length} JSX/TS file(s) under ${ROOTS.join(', ')}`);
console.log(`  client plane          ${clientPlane.size} module(s) (${clientRoots.length} carry the 'use client' directive); ${serverOnly} file(s) render on the server and are out of scope`);
console.log(`  slots read            ${slotsScanned} multi-child slot(s)`);
console.log(`  node-typed props      ${propsRead} prop(s) read in a multi-child slot`);
if (VERBOSE) {
  for (const o of offenders) console.log(`      ${o.file}:${o.line}  ${o.component}(${o.prop}) -> <${o.slot}> of ${o.size}`);
}
if (offenders.length > 0) {
  console.log(`\nOFFENDERS (${offenders.length}):`);
  for (const o of offenders) {
    console.log(`  - ${o.file}:${o.line} — ${o.component} renders \`${o.prop}\` as a bare member of a ${o.size}-child `
      + `<${o.slot}> slot; a value that crosses the RSC boundary arrives there unvalidated and React logs `
      + '"Each child in a list should have a unique \\"key\\" prop"');
  }
  console.log('\nRESULT: FAIL — a client-plane slot can render an unkeyed list member');
  process.exit(REPORT_ONLY ? 0 : 1);
}
console.log('\nRESULT: PASS — no client-plane multi-child slot renders a ReactNode-typed prop as a bare member');
