// Math in study sets (see src/lib/studyMath.ts) and the delimiter repairs every
// message gets (src/lib/normalizeMath.ts). The study cases are real failures:
// a single backslash in a tool call's JSON arrives as a control character.

import test from "node:test";
import assert from "node:assert/strict";
import { repairLatexEscapes, wrapBareLatex, studyMath } from "../src/lib/studyMath.ts";
import { normalizeMath, escapeLoneDollars } from "../src/lib/normalizeMath.ts";

// What a JSON parser makes of a model's single-backslash LaTeX: `\f` is a form
// feed, `\b` a backspace, `\t` a tab, `\r` a carriage return, `\n` a newline.
const viaJson = (s) =>
  s.replace(/\\([fbtrn])/g, (_m, c) => ({ f: "\f", b: "\b", t: "\t", r: "\r", n: "\n" })[c]);

test("commands eaten by JSON escapes come back", () => {
  assert.equal(repairLatexEscapes(viaJson("$\\frac{1}{2}$")), "$\\frac{1}{2}$");
  assert.equal(repairLatexEscapes(viaJson("$\\beta + \\theta \\times \\rho$")), "$\\beta + \\theta \\times \\rho$");
  assert.equal(repairLatexEscapes(viaJson("$\\left( x \\right)$")), "$\\left( x \\right)$");
  assert.equal(repairLatexEscapes(viaJson("$\\nabla f \\neq 0$")), "$\\nabla f \\neq 0$");
});

test("real line breaks and tabs are left alone", () => {
  assert.equal(repairLatexEscapes("first line\nnot math"), "first line\nnot math");
  assert.equal(repairLatexEscapes("a\r\nb\t1"), "a\r\nb\t1");
  assert.equal(repairLatexEscapes("```\n\tfoo()\n```"), "```\n\tfoo()\n```");
});

test("bare LaTeX is wrapped, prose and delimited math are not", () => {
  assert.equal(wrapBareLatex("\\sqrt{2}"), "$\\sqrt{2}$");
  assert.equal(wrapBareLatex("x^{2} + 1"), "$x^{2} + 1$");
  assert.equal(wrapBareLatex("It equals \\frac{a b}{c}."), "It equals $\\frac{a b}{c}$.");
  assert.equal(wrapBareLatex("Set v_0 = 3 then"), "Set $v_0 = 3$ then");
  assert.equal(wrapBareLatex("a \\pi radians"), "a $\\pi$ radians");
  assert.equal(wrapBareLatex("Already $\\pi$ and x^2"), "Already $\\pi$ and x^2");
  assert.equal(wrapBareLatex("the file_name field"), "the file_name field");
  assert.equal(wrapBareLatex("Plain answer"), "Plain answer");
  assert.equal(wrapBareLatex("`\\alpha` in code"), "`\\alpha` in code");
});

test("studyMath does both, in order", () => {
  assert.equal(studyMath(viaJson("\\frac{\\pi}{2}")), "$\\frac{\\pi}{2}$");
  assert.equal(studyMath(null), "");
});

test("lone dollars are escaped, pairs kept", () => {
  assert.equal(escapeLoneDollars("costs $5 and $10 today"), "costs \\$5 and \\$10 today");
  assert.equal(escapeLoneDollars("$x$ costs $5"), "$x$ costs \\$5");
  assert.equal(escapeLoneDollars("$ x + y $"), "$ x + y $");
  assert.equal(escapeLoneDollars("$2x + 1$ is odd"), "$2x + 1$ is odd");
  assert.equal(escapeLoneDollars("open $x\n\nnext $y$"), "open \\$x\n\nnext $y$");
  assert.equal(escapeLoneDollars("already \\$5"), "already \\$5");
});

test("normalizeMath lifts bare environments and keeps code", () => {
  const out = normalizeMath("Solve \\begin{cases} x = 1 \\\\ y = 2 \\end{cases} now");
  assert.match(out, /\n\$\$\n\\begin\{cases\}[\s\S]*\\end\{cases\}\n\$\$\n/);
  assert.ok(out.startsWith("Solve\n\n$$\n\\begin{cases}") && out.endsWith("\\end{cases}\n$$\n\nnow"), "prose stays prose");
  // The math around a bare environment on its line is one equation with it.
  const inv = normalizeMath(
    "Inverse: \\begin{pmatrix} a \\end{pmatrix}^{-1} = \\frac{1}{ad-bc}\\begin{pmatrix} d \\end{pmatrix}.",
  );
  assert.equal(
    inv,
    "Inverse:\n\n$$\n\\begin{pmatrix} a \\end{pmatrix}^{-1} = \\frac{1}{ad-bc}\\begin{pmatrix} d \\end{pmatrix}.\n$$\n\n",
  );
  assert.equal(wrapBareLatex("Solve \\begin{cases} x \\end{cases}"), "Solve \\begin{cases} x \\end{cases}");
  const inline = "$\\begin{pmatrix} 1 \\end{pmatrix}$";
  assert.equal(normalizeMath(inline), inline);
  assert.equal(normalizeMath("`echo $5 $6`"), "`echo $5 $6`");
  assert.equal(normalizeMath("price $5"), "price \\$5");
});
