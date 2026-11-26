#!/usr/bin/env node
// Generate the index Settings search runs over.
//
//   node scripts/gen-settings-index.mjs           # write src/lib/settingsIndex.generated.ts
//   node scripts/gen-settings-index.mjs --check   # fail if the checked-in file is stale
//
// Read from the tabs' own source rather than kept as a list: Settings renders
// one tab at a time, so search cannot read the other tabs off the page, and a
// hand-kept list of every section would be a second copy of each heading that
// quietly disagrees with the first. Each `<h3>` a tab renders is one entry; its
// description is the first `<p>` in its section; its keywords are the other
// words the section shows (toggle labels, option labels, help text). `--check`
// runs in the test suite, so a new section is searchable in the commit that
// adds it.
//
// The TypeScript parser (already a dev dependency) rather than a regex, because
// a section's text is spread over nested JSX, attributes and option arrays.

import ts from "typescript";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODAL = "src/components/Settings/SettingsModal.tsx";
export const OUTPUT = "src/lib/settingsIndex.generated.ts";

const files = new Map();

function parse(file) {
  if (!files.has(file)) {
    const text = readFileSync(file, "utf8");
    files.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  }
  return files.get(file);
}

/** Resolve an import to a component file, or null for anything outside src/components. */
function resolve(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.posix.join("src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(from), spec);
  else return null;
  if (!base.startsWith("src/components/")) return null;
  for (const ext of [".tsx", ".ts", "/index.tsx"]) if (existsSync(base + ext)) return base + ext;
  return null;
}

/** Top-level functions (declared or `const X = () =>`) and imported names of one file. */
function scopeOf(file) {
  const sf = parse(file);
  const fns = new Map();
  const imports = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) fns.set(st.name.text, st);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          fns.set(d.name.text, d.initializer);
        }
      }
    } else if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      const target = resolve(file, st.moduleSpecifier.text);
      if (!target) continue;
      for (const el of st.importClause.namedBindings.elements) imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
    }
  }
  return { fns, imports };
}

const tagName = (el) => (ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName).getText();
const isJsx = (n) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n);

/** JSX's own whitespace rule: lines are trimmed and joined with one space. */
const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };

function jsxText(raw) {
  raw = raw.replace(/&(lt|gt|amp|quot|apos|nbsp);/g, (_, e) => ENTITIES[e]);
  const lines = raw.split(/\r?\n/);
  if (lines.length === 1) return raw;
  return lines
    .map((l, i) => (i > 0 ? l.trimStart() : l))
    .map((l, i, a) => (i < a.length - 1 ? l.trimEnd() : l))
    .filter((l) => l.length > 0)
    .join(" ");
}

const tidy = (s) => s.replace(/\s+/g, " ").replace(/\s+([.,;:!?)])/g, "$1").trim();

/** The visible text of an element, with `null` where an expression is. */
function childText(el, parts = []) {
  if (!ts.isJsxElement(el)) return parts;
  for (const c of el.children) {
    if (ts.isJsxText(c)) parts.push(jsxText(c.text));
    else if (ts.isJsxExpression(c)) {
      if (c.expression && ts.isStringLiteralLike(c.expression)) parts.push(c.expression.text);
      else if (c.expression) parts.push(null);
    } else if (ts.isJsxElement(c)) childText(c, parts);
  }
  return parts;
}

/**
 * A heading's searchable name. A dynamic tail ("Stored memories ({n})") keeps
 * its literal start, which is also what the page is searched for when jumping
 * to it; a heading that starts dynamic ("Install {name}" in a dialog, an
 * edit/new ternary) is not a setting anyone types the name of.
 */
function headingOf(h3) {
  const parts = childText(h3).filter((p) => p === null || p.trim() !== "");
  if (parts.length === 0 || parts[0] === null) return null;
  const dynamic = parts.includes(null);
  let text = parts.slice(0, dynamic ? parts.indexOf(null) : parts.length).join("");
  if (dynamic) {
    // "Colours · {mode}" qualifies its heading; "Install {name}" is about the name.
    if (!/[·:(\-–—]\s*$/.test(text)) return null;
    text = text.replace(/[\s·:(\-–—]+$/, "");
  }
  text = tidy(text);
  return text.length >= 3 ? text : null;
}

const SKIP_ATTRS = /^(className|style|key|value|type|id|href|src|role|on[A-Z].*|data-.*|aria-.*|ref|name|accept|inputMode|autoComplete)$/;

/** Every phrase a section shows, beyond its heading. */
function phrasesIn(scope) {
  const out = [];
  const walk = (n, skip) => {
    if (ts.isJsxAttribute(n) && SKIP_ATTRS.test(n.name.getText())) return;
    // Inline handlers compare against key names and set values — not words on screen.
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return;
    if (ts.isJsxText(n)) {
      const t = tidy(jsxText(n.text));
      if (t) out.push(t);
    } else if (ts.isStringLiteralLike(n) && !skip) {
      const t = tidy(n.text);
      // Lower-case single tokens are values ("tab", "ctrl_enter"), not labels.
      if (t && !/^[a-z0-9_.:\-/]+$/.test(t) && !t.includes("var(--")) out.push(t);
    }
    ts.forEachChild(n, (c) => walk(c, skip));
  };
  walk(scope, false);
  return out;
}

function h3Count(n) {
  let count = 0;
  const walk = (x) => {
    if (isJsx(x) && tagName(x) === "h3") count++;
    if (!ts.isArrowFunction(x) || x === n) ts.forEachChild(x, walk);
  };
  walk(n);
  return count;
}

/**
 * The element a heading names: the largest one around it that holds no other
 * heading, stopping at a function (a `.map` callback repeats, so it is not one
 * setting). The page does the same walk in the DOM to find what to highlight.
 */
function sectionOf(h3) {
  let scope = h3;
  for (let n = h3.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) break;
    if (isJsx(n)) {
      if (h3Count(n) > 1) break;
      scope = n;
    }
  }
  return scope;
}

function insideArrow(n, fn) {
  for (let p = n.parent; p && p !== fn; p = p.parent) if (ts.isFunctionLike(p)) return true;
  return false;
}

function insideAdvanced(n, fn) {
  for (let p = n.parent; p && p !== fn; p = p.parent) if (isJsx(p) && tagName(p) === "Advanced") return true;
  return false;
}

/** Collect the entries one component renders, following the components it uses. */
function visit(file, fnName, tab, advanced, seen, out) {
  const key = `${file}#${fnName}`;
  if (seen.has(key)) return;
  seen.add(key);
  const { fns, imports } = scopeOf(file);
  const fn = fns.get(fnName);
  if (!fn) return;
  const walk = (n) => {
    if (isJsx(n)) {
      const name = tagName(n);
      if (name === "h3" && !insideArrow(n, fn)) {
        const heading = headingOf(n);
        if (heading) {
          const scope = sectionOf(n);
          const p = [];
          scope !== n && ts.forEachChild(scope, function find(c) {
            if (!p.length && isJsx(c) && tagName(c) === "p") p.push(tidy(childText(c).filter((x) => x !== null).join("")));
            else if (!p.length) ts.forEachChild(c, find);
          });
          const description = p[0] ?? "";
          const keywords = [...new Set(phrasesIn(scope))].filter(
            (k) => k !== heading && !description.includes(k) && !heading.includes(k) && !k.startsWith(heading) && k.length >= 3 && /[a-z]/i.test(k),
          );
          out.push({ tab, heading, description, keywords, ...(advanced || insideAdvanced(n, fn) ? { advanced: true } : {}) });
        }
      } else if (/^[A-Z]/.test(name)) {
        const adv = advanced || insideAdvanced(n, fn);
        if (fns.has(name)) visit(file, name, tab, adv, seen, out);
        else if (imports.has(name)) visit(imports.get(name).file, imports.get(name).name, tab, adv, seen, out);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(fn);
}

/** The tabs the modal renders, in its order: `{tab === "chat" && <ChatTab />}`. */
function tabsOf() {
  const sf = parse(MODAL);
  const { imports } = scopeOf(MODAL);
  const labels = {};
  const tabs = [];
  const walk = (n) => {
    if (ts.isVariableDeclaration(n) && n.name.getText() === "TAB_LABELS" && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
      for (const p of n.initializer.properties) if (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) labels[p.name.getText()] = p.initializer.text;
    }
    if (
      ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      ts.isBinaryExpression(n.left) && n.left.left.getText() === "tab" && ts.isStringLiteral(n.left.right) &&
      ts.isJsxSelfClosingElement(n.right)
    ) {
      const comp = imports.get(n.right.tagName.getText());
      if (comp) tabs.push({ id: n.left.right.text, ...comp });
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return tabs.map((t) => ({ ...t, label: labels[t.id] ?? t.id }));
}

export function generate() {
  files.clear();
  const entries = [];
  for (const t of tabsOf()) {
    const out = [];
    visit(t.file, t.name, t.id, false, new Set(), out);
    const seen = new Set();
    for (const e of out) {
      if (seen.has(e.heading)) continue;
      seen.add(e.heading);
      entries.push({ tab: e.tab, tabLabel: t.label, heading: e.heading, description: e.description, keywords: e.keywords, ...(e.advanced ? { advanced: true } : {}) });
    }
  }
  if (entries.length < 40) throw new Error(`only ${entries.length} settings found — has ${MODAL} changed shape?`);
  return (
    "// Generated by scripts/gen-settings-index.mjs from the Settings tabs. Do not edit;\n" +
    "// run `node scripts/gen-settings-index.mjs` after changing a section.\n\n" +
    'import type { SettingsEntry } from "./settingsSearch";\n\n' +
    `export const SETTINGS_INDEX: SettingsEntry[] = ${JSON.stringify(entries, null, 2)};\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = generate();
  if (process.argv.includes("--check")) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
    if (current !== next) {
      console.error(`${OUTPUT} is stale — run: node scripts/gen-settings-index.mjs`);
      process.exit(1);
    }
  } else {
    writeFileSync(OUTPUT, next);
    console.log(`wrote ${OUTPUT}`);
  }
}
