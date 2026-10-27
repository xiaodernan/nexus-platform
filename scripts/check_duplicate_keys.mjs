#!/usr/bin/env node
/**
 * NEXUS D575 -- the React key every card list member carries, and whether two members of ONE list can
 * carry the same one.
 *
 * THE DEFECT. React's reconciler keeps a set of the keys it has already seen in the children array it
 * is walking, and when a key comes round twice it logs "Encountered two children with the same key"
 * (`node_modules/react-dom/cjs/react-dom-client.development.js`, `warnOnInvalidKey`). Two members of
 * one list may not share a key: the second one takes the first one's place on update, so the list
 * duplicates or drops a member.
 *
 * A card's `id` is its IDENTITY, and an identity is not unique inside a list that holds that card
 * twice. The platform keeps those repeats on purpose -- `CollectionsController` resolves a guide's
 * items in the author's order and adds the card each item resolved, so a guide that cites one shop in
 * two places yields that shop's card twice, and the seeded Sha Tin date-night route does exactly that
 * (`data/seed/generate.py`, `build_collections`: `datey[:9] + datey[:1]`, so the route holds ten
 * references over nine shops). A key therefore has to name the OCCURRENCE, not the identity -- see
 * `packages/ui/src/trust/cardKeys.ts`.
 *
 * WHY A RUNTIME WITNESS. The duplicate-key warning lives only in the client reconciler: it is absent
 * from every `react-dom-server*.development.js` build, and `renderToStaticMarkup` emits nothing for a
 * list whose members share a key (measured). So no server render can decide this. This reader instead
 * RUNS the real component and reads the element tree it returns: calling a function component yields
 * the very elements React would reconcile, and the rule React applies -- the members of one children
 * array must carry distinct keys -- is a property of that tree, not of a browser.
 *
 * WHAT IT READS. The same three source roots as the slot-key census: `apps/web/app`, `apps/web/src`
 * and `packages/ui/src`.
 *
 *   THE CLIENT PLANE -- the modules carrying the `'use client'` directive, plus every module they
 *   import (transitively, through relative paths, `@/...` and `@nexus/ui/...`). A module outside this
 *   plane renders on the server, where the warning does not exist.
 *
 *   THE POPULATION -- the components that take a LIST OF IDENTITY-BEARING OBJECTS: a prop whose
 *   declared type is an array of a type that declares `id: string`. The identity-bearing types are
 *   resolved through the imports, so `EntityCardModel` in `apps/web` and `EntityCard` in
 *   `packages/ui` are the same type and both are found. Each such component is then CALLED with a
 *   fixture whose list holds one identity twice, and the tree it returns is walked.
 *
 * THE FIXTURE. One list member per identity, and one identity twice: `dup`, `other`, `dup`. A list
 * that keys by identity gives `dup` twice; a list that keys by occurrence gives `dup` and `dup#1`.
 * The other props are furnished from their DECLARED types: strings become `'en'`, functions become
 * no-ops, the labels object becomes the real `trustLabels('en')`, and a list of non-identity objects
 * becomes one member so the component's own list is not empty. A REQUIRED prop whose type the reader
 * cannot furnish is a REFUSAL, not a verdict: the component was not run, and "did not run" is not
 * "found nothing".
 *
 * WHAT IT DOES NOT DO, stated rather than implied.
 *   - It does not run a browser, and it does not check the MISSING-key warning (a list member with no
 *     key at all) -- that is the slot-key census's subject (`scripts/check_slot_keys.mjs`).
 *   - It does not decide whether a list really can hold the same card twice; it asks whether the
 *     shape CAN warn. A prop that only ever receives distinct cards is judged the same way.
 *   - It reads the client plane only. The same shape in a server module is not this defect.
 *
 * Usage: node scripts/check_duplicate_keys.mjs [--plane <dir>] [--report] [--verbose]
 * Exit:  0 no list can carry the same key twice; 1 a list can; 2 the census itself is not trustworthy.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
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
    + `${missing.join(', ')}. A tree this reader cannot see is not a tree whose lists are safe.`);
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

/** The interfaces and type aliases a file declares, by name. */
function localDecls(sf) {
  const map = new Map();
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st)) map.set(st.name.text, { kind: 'interface', node: st });
    else if (ts.isTypeAliasDeclaration(st)) map.set(st.name.text, { kind: 'alias', node: st });
  }
  return map;
}

/** The local name a module gives an imported binding, and where it came from. */
function importMap(sf) {
  const map = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    if (!clause) continue;
    const spec = st.moduleSpecifier.text;
    if (clause.name) map.set(clause.name.text, { module: spec, imported: 'default' });
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) map.set(el.name.text, { module: spec, imported: (el.propertyName ?? el.name).text });
    }
  }
  return map;
}

/** Resolve a module specifier to a file inside the plane. */
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
 * `export * from './primitives/Layout'` and the like, and it carries no `'use client'` directive of
 * its own. A client module that imports `@nexus/ui` therefore pulls the whole barrel into the client
 * bundle -- through the re-export, not through an import statement.
 */
function importSpecifiers(sf) {
  const out = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) out.push(st.moduleSpecifier.text);
    else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- the client plane */

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

/* ---------------------------------------------------------------- the types */

/**
 * The declaration a type name stands for, followed through the imports.
 *
 * The chain set is COPIED rather than mutated, so two resolutions that start from the same file do not
 * poison each other: the reader asks "is this an identity type?" and then "what is this type?" about
 * the same name, and the second question must not be answered by the first one's bookkeeping.
 */
function resolveDecl(name, fileAbs, seen = new Set()) {
  const info = infos.get(fileAbs);
  if (!info) return null;
  const local = localDecls(info.sf).get(name);
  if (local) return { ...local, file: fileAbs };
  const imp = importMap(info.sf).get(name);
  if (!imp) return null;
  const target = resolveModule(imp.module, fileAbs);
  if (!target || !infos.has(target)) return null;
  const mark = `${target}#${imp.imported}`;
  if (seen.has(mark)) return null;
  const next = new Set(seen);
  next.add(mark);
  const decl = localDecls(infos.get(target).sf).get(imp.imported);
  return decl ? { ...decl, file: target } : null;
}

/**
 * The members of a props type: an inline literal, an interface, an alias, an intersection.
 *
 * Every member carries the SCOPE its type node was written in, because a member of an interface
 * declared in `packages/ui/src/trust/types.ts` names types that only that file can resolve.
 */
function resolveMembers(typeNode, fileAbs, seen = new Set()) {
  if (!typeNode) return [];
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.filter((m) => ts.isPropertySignature(m)).map((m) => ({
      name: m.name.getText(), type: m.type, optional: Boolean(m.questionToken), scope: fileAbs,
    }));
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.flatMap((t) => resolveMembers(t, fileAbs, seen));
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText();
    if (name === 'React.FC' || name === 'FC' || name === 'React.FunctionComponent' || name === 'FunctionComponent') {
      const arg = typeNode.typeArguments?.[0];
      return arg ? resolveMembers(arg, fileAbs, seen) : [];
    }
    const decl = resolveDecl(name, fileAbs, seen);
    if (!decl) return [];
    if (decl.kind === 'interface') {
      const own = decl.node.members.filter((m) => ts.isPropertySignature(m)).map((m) => ({
        name: m.name.getText(), type: m.type, optional: Boolean(m.questionToken), scope: decl.file,
      }));
      const inherited = (decl.node.heritageClauses ?? []).flatMap((h) => h.types)
        .flatMap((t) => resolveMembers(t, decl.file, seen));
      return [...inherited, ...own];
    }
    return resolveMembers(decl.node.type, decl.file, seen);
  }
  return [];
}

/** Is this type the `string` primitive? */
function isStringType(typeNode) {
  if (!typeNode) return false;
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) return true;
  return ts.isTypeReferenceNode(typeNode) && typeNode.typeName.getText() === 'string';
}

/** The type name an array's element stands for, when it is a named type. */
function namedElement(typeNode) {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return null;
  return typeNode.typeName.getText();
}

function declMembers(decl, seen = new Set()) {
  if (decl.kind === 'interface') {
    const own = decl.node.members.filter((m) => ts.isPropertySignature(m)).map((m) => ({
      name: m.name.getText(), type: m.type, optional: Boolean(m.questionToken), scope: decl.file,
    }));
    const inherited = (decl.node.heritageClauses ?? []).flatMap((h) => h.types)
      .flatMap((t) => resolveMembers(t, decl.file, seen));
    return [...inherited, ...own];
  }
  return resolveMembers(decl.node.type, decl.file, seen);
}

/**
 * Does this type declare an identity -- a member `id` of type `string`?
 *
 * This is what makes a list of these objects a list whose members React must key, and an identity that
 * can appear twice in one list is the whole defect.
 */
function isIdentityType(typeNode, fileAbs) {
  const name = namedElement(typeNode);
  if (!name) return false;
  const decl = resolveDecl(name, fileAbs);
  if (!decl) return false;
  const id = declMembers(decl).find((m) => m.name === 'id');
  return Boolean(id) && isStringType(id.type);
}

/* ---------------------------------------------------------------- the components */

/** Does this function's body contain JSX? A function that returns a value is not a component. */
function containsJsx(fn) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

/** Every component in a file, with the props type it declares. */
function componentsIn(sf) {
  const comps = [];
  const visit = (n) => {
    let name = null;
    let fn = null;
    if (ts.isFunctionDeclaration(n) && n.name) { name = n.name.text; fn = n; }
    else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer
          && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          name = d.name.text; fn = d.initializer;
        }
      }
    }
    if (name && fn && containsJsx(fn)) comps.push({ name, fn, propsType: fn.parameters?.[0]?.type ?? null });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return comps;
}

/* ---------------------------------------------------------------- the loader */

/**
 * A loader that turns a TSX module into a running module.
 *
 * The reader has to CALL the components it judges, so the source has to become code. The TypeScript
 * compiler API does that (`ts.transpileModule` to CommonJS with the JSX runtime), and `typescript` is
 * already a declared devDependency of `apps/web` -- the slot-key census uses it too. `react` comes
 * from the real `node_modules`, so the elements the components return are the real React elements and
 * carry real keys; `next/*` is stubbed, because a link renders nothing this reader has to see.
 */
const require_ = createRequire(join(ROOT, 'package.json'));
const moduleCache = new Map();

function loaderTarget(spec, fromFile) {
  if (spec.startsWith('.')) return resolve(dirname(fromFile), spec);
  if (spec.startsWith('@/')) return join(PLANE, 'apps', 'web', 'src', spec.slice(2));
  if (spec === '@nexus/ui') return join(PLANE, 'packages', 'ui', 'src', 'index.ts');
  if (spec.startsWith('@nexus/ui/')) return join(PLANE, 'packages', 'ui', 'src', spec.slice('@nexus/ui/'.length));
  return null;
}

function loaderCandidate(base) {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try { if (existsSync(c) && statSync(c).isFile()) return c; } catch { /* not this candidate */ }
  }
  return null;
}

function loadModule(abs) {
  if (moduleCache.has(abs)) return moduleCache.get(abs).exports;
  const src = readFileSync(abs, 'utf8');
  const js = ts.transpileModule(src, {
    fileName: abs,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      verbatimModuleSyntax: false,
    },
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(abs, module);
  const localRequire = (spec) => {
    if (spec.startsWith('next/')) {
      const stub = () => null;
      return { __esModule: true, default: stub };
    }
    const mapped = loaderTarget(spec, abs);
    if (mapped) {
      const target = loaderCandidate(mapped);
      if (target) return loadModule(target);
    }
    if (/\.(css|scss|png|svg)$/.test(spec)) return {};
    return require_(spec);
  };
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', js);
  fn(module.exports, localRequire, module, abs, dirname(abs));
  return module.exports;
}

/* ---------------------------------------------------------------- the fixture */

/** The labels a card renders with: the real `trustLabels('en')`, loaded from the app's own dictionary. */
let realLabels = null;
function labelsFixture() {
  if (realLabels) return realLabels;
  const mod = loadModule(loaderCandidate(join(PLANE, 'apps', 'web', 'src', 'lib', 'i18n', 'index.ts')));
  realLabels = mod.trustLabels('en');
  return realLabels;
}

const DUP_ID = 'dup';

/** A list of identity-bearing objects whose FIRST identity appears twice. */
function identityList(decl) {
  const card = {};
  for (const m of declMembers(decl)) {
    if (m.name === 'id') continue;
    const f = fixtureFor(m.type, m.scope);
    if (f.ok) card[m.name] = f.value;
  }
  card.id = DUP_ID;
  const other = { ...card, id: 'other' };
  const again = { ...card, id: DUP_ID };
  return [card, other, again];
}

const unfurnishable = (reason) => ({ ok: false, reason });

/**
 * A value for a declared type.
 *
 * The reader furnishes what it can and says so when it cannot: an unfurnishable REQUIRED prop is a
 * refusal (the component was not run), an unfurnishable OPTIONAL prop is left out.
 */
function fixtureFor(typeNode, fileAbs, depth = 0) {
  if (!typeNode) return unfurnishable('the type is not declared');
  if (depth > 6) return unfurnishable('the type nests too deeply to furnish');
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) return { ok: true, value: 'en' };
  if (typeNode.kind === ts.SyntaxKind.NumberKeyword) return { ok: true, value: 0 };
  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) return { ok: true, value: false };
  if (typeNode.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword) return { ok: true, value: undefined };
  if (typeNode.kind === ts.SyntaxKind.UnknownKeyword || typeNode.kind === ts.SyntaxKind.AnyKeyword) {
    return { ok: true, value: undefined };
  }
  if (ts.isLiteralTypeNode(typeNode)) {
    return { ok: true, value: String(typeNode.literal.getText()).replace(/^['"]|['"]$/g, '') };
  }
  if (ts.isFunctionTypeNode(typeNode)) return { ok: true, value: () => undefined };
  if (ts.isUnionTypeNode(typeNode)) {
    for (const t of typeNode.types) {
      if (t.kind === ts.SyntaxKind.NullKeyword || t.kind === ts.SyntaxKind.UndefinedKeyword) continue;
      const f = fixtureFor(t, fileAbs, depth + 1);
      if (f.ok) return f;
    }
    return unfurnishable('no member of the union can be furnished');
  }
  if (ts.isArrayTypeNode(typeNode)) {
    const name = namedElement(typeNode.elementType);
    if (name && isIdentityType(typeNode.elementType, fileAbs)) {
      return { ok: true, value: identityList(resolveDecl(name, fileAbs)) };
    }
    const el = fixtureFor(typeNode.elementType, fileAbs, depth + 1);
    if (!el.ok) return unfurnishable(`a list of ${typeNode.elementType.getText()} cannot be furnished`);
    return { ok: true, value: [el.value] };
  }
  if (ts.isTypeLiteralNode(typeNode)) {
    const out = {};
    for (const m of typeNode.members.filter((x) => ts.isPropertySignature(x))) {
      const f = fixtureFor(m.type, fileAbs, depth + 1);
      if (f.ok) out[m.name.getText()] = f.value;
      else if (!m.questionToken) return unfurnishable(`the member \`${m.name.getText()}\` cannot be furnished`);
    }
    return { ok: true, value: out };
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const text = typeNode.typeName.getText();
    if (text === 'Record') return { ok: true, value: {} };
    if (text === 'ReactNode' || text === 'React.ReactNode' || text === 'ReactElement' || text === 'React.ReactElement') {
      return { ok: true, value: undefined };
    }
    const decl = resolveDecl(text, fileAbs);
    if (!decl) return unfurnishable(`the type \`${text}\` is not declared where the reader can see it`);
    if (decl.kind === 'interface' && decl.node.name.text === 'TrustLabels'
      && /packages[\\/]ui[\\/]src[\\/]trust[\\/]Renderers\.tsx$/.test(decl.file)) {
      return { ok: true, value: labelsFixture() };
    }
    if (decl.kind === 'alias') return fixtureFor(decl.node.type, decl.file, depth + 1);
    const out = {};
    for (const m of declMembers(decl)) {
      const f = fixtureFor(m.type, m.scope, depth + 1);
      if (f.ok) out[m.name] = f.value;
      else if (!m.optional) return unfurnishable(`the member \`${m.name}\` of \`${decl.node.name.text}\` cannot be furnished`);
    }
    return { ok: true, value: out };
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    const out = {};
    for (const t of typeNode.types) {
      const f = fixtureFor(t, fileAbs, depth + 1);
      if (!f.ok) return f;
      if (f.value && typeof f.value === 'object' && !Array.isArray(f.value)) Object.assign(out, f.value);
      else out.value = f.value;
    }
    return { ok: true, value: out };
  }
  return unfurnishable(`the type \`${typeNode.getText()}\` has no fixture`);
}

/* ---------------------------------------------------------------- the walk */

const isElement = (n) => Boolean(n) && typeof n === 'object' && typeof n.$$typeof === 'symbol';

function typeName(el) {
  const t = el.type;
  if (typeof t === 'string') return t;
  if (typeof t === 'function') return t.name || 'Component';
  if (typeof t === 'symbol') return 'Fragment';
  return 'Unknown';
}

/**
 * The rule React applies, read off the tree: the members of ONE children array must carry distinct
 * keys. React reconciles each array as its own list with its own set of seen keys
 * (`reconcileChildrenArray`), so a nested array is a list of its own.
 */
function scanElement(el, out, where) {
  if (!isElement(el)) return;
  const children = el.props?.children;
  if (Array.isArray(children)) {
    const seen = new Map();
    for (const child of children) {
      if (isElement(child)) {
        const key = child.key;
        if (typeof key === 'string') {
          const prior = seen.get(key);
          if (prior !== undefined) {
            seen.set(key, prior + 1);
            out.push({ ...where, slot: typeName(el), key, count: prior + 1 });
          } else seen.set(key, 1);
        }
        scanElement(child, out, where);
      } else if (Array.isArray(child)) {
        const nested = new Map();
        for (const member of child) {
          if (!isElement(member)) continue;
          const key = member.key;
          if (typeof key === 'string') {
            const prior = nested.get(key);
            if (prior !== undefined) {
              nested.set(key, prior + 1);
              out.push({ ...where, slot: typeName(el), key, count: prior + 1 });
            } else nested.set(key, 1);
          }
          scanElement(member, out, where);
        }
      }
    }
  } else if (isElement(children)) {
    scanElement(children, out, where);
  }
}

/* ---------------------------------------------------------------- the run */

const offenders = [];
const refusals = [];
let componentsRun = 0;

for (const abs of clientPlane) {
  const info = infos.get(abs);
  if (!info) continue;
  const comps = componentsIn(info.sf).filter((c) => c.propsType);
  if (comps.length === 0) continue;

  const cardListComps = comps.filter((c) => resolveMembers(c.propsType, abs).some((m) => m.type
    && ts.isArrayTypeNode(m.type) && isIdentityType(m.type.elementType, abs)));
  if (cardListComps.length === 0) continue;

  let exports;
  try {
    exports = loadModule(abs);
  } catch (e) {
    refusals.push(`${rel(abs)} could not be loaded: ${e && e.message ? e.message : e}`);
    continue;
  }

  for (const comp of cardListComps) {
    const fn = exports[comp.name];
    if (typeof fn !== 'function') continue;  // not exported: not a surface anything can reach
    const props = {};
    let missingProp = null;
    for (const m of resolveMembers(comp.propsType, abs)) {
      const f = fixtureFor(m.type, m.scope);
      if (f.ok) props[m.name] = f.value;
      else if (!m.optional) { missingProp = `\`${m.name}\``; break; }
    }
    if (missingProp) {
      refusals.push(`${rel(abs)} — ${comp.name} declares a required prop ${missingProp} whose type the reader cannot furnish`);
      continue;
    }
    let tree;
    try {
      tree = fn(props);
    } catch (e) {
      refusals.push(`${rel(abs)} — calling ${comp.name} threw: ${e && e.message ? e.message : e}`);
      continue;
    }
    if (!isElement(tree)) {
      refusals.push(`${rel(abs)} — ${comp.name} returned no tree for the fixture, so its list was never reached`);
      continue;
    }
    componentsRun += 1;
    const found = [];
    scanElement(tree, found, { file: rel(abs), component: comp.name });
    for (const f of found) offenders.push(f);
    if (VERBOSE) {
      console.log(`      ${rel(abs)} — ${comp.name} ran; ${found.length} duplicate key(s)`);
    }
  }
}

/* ---------------------------------------------------------------- the verdict */

const serverOnly = files.length - clientPlane.size;
console.log('NEXUS — the React key every card list member carries, and whether two members of one list can share one');
console.log(`  plane read            ${PLANE}`);
console.log(`  population            ${files.length} JSX/TS file(s) under ${ROOTS.join(', ')}`);
console.log(`  client plane          ${clientPlane.size} module(s) (${clientRoots.length} carry the 'use client' directive); `
  + `${serverOnly} file(s) render on the server and are out of scope`);
console.log(`  components run        ${componentsRun} card-list component(s)`);
console.log(`  duplicate keys        ${offenders.length}`);

if (refusals.length) {
  console.log('\nNOT RUN (the reader could not judge these):');
  for (const r of refusals) console.log(`  - ${r}`);
  console.log('\nRESULT: NOT CHECKED — the reader could not run every card-list component, so a clean reading '
    + 'of the ones it did run clears nothing.');
  process.exit(2);
}

if (offenders.length > 0) {
  console.log(`\nOFFENDERS (${offenders.length}):`);
  for (const o of offenders) {
    console.log(`  - ${o.file} — ${o.component} renders ${o.count} list members of one <${o.slot}> slot with the key `
      + `\`${o.key}\`; two members of one list may not share a key, and React logs "Encountered two children with the `
      + 'same key"');
  }
  console.log('\nRESULT: FAIL — a card list can render two members with the same key');
  process.exit(REPORT_ONLY ? 0 : 1);
}
console.log('\nRESULT: PASS — no card list renders two members of one slot with the same key');
