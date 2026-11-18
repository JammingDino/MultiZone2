// Paths in pasted text (0.19.3): what becomes a "Give access" chip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findPaths, unquote } from "../src/lib/pathText.ts";

test("Explorer's Copy as path, quotes and all", () => {
  assert.deepEqual(findPaths('"C:\\Users\\levi\\Desktop\\spec.pdf"'), ["C:\\Users\\levi\\Desktop\\spec.pdf"]);
});

test("one per line, with a trailing newline and spaces in names", () => {
  const text = '"D:\\Data\\logs"\r\n"D:\\My Projects\\site"\r\n';
  assert.deepEqual(findPaths(text), ["D:\\Data\\logs", "D:\\My Projects\\site"]);
});

test("several quoted paths on one line", () => {
  assert.deepEqual(findPaths('"C:\\a" "C:\\b"'), ["C:\\a", "C:\\b"]);
});

test("bare paths, forward slashes and UNC shares", () => {
  assert.deepEqual(findPaths("C:/work/repo"), ["C:/work/repo"]);
  assert.deepEqual(findPaths("\\\\nas\\share\\docs"), ["\\\\nas\\share\\docs"]);
  assert.deepEqual(findPaths("D:\\Data\\logs\\"), ["D:\\Data\\logs"]);
});

test("text that isn't a path is left alone", () => {
  assert.deepEqual(findPaths("please fix the build"), []);
  assert.deepEqual(findPaths("relative\\path\\here"), []);
  assert.deepEqual(findPaths("src/lib/x.ts"), []);
  assert.deepEqual(findPaths("C: drive is full"), []);
  assert.deepEqual(findPaths(""), []);
});

test("duplicates collapse and the count is capped", () => {
  assert.deepEqual(findPaths("C:\\a\nC:\\a"), ["C:\\a"]);
  const many = Array.from({ length: 25 }, (_, i) => `C:\\dir${i}`).join("\n");
  assert.equal(findPaths(many).length, 10);
});

test("unquote strips one matching pair only", () => {
  assert.equal(unquote('  "C:\\x"  '), "C:\\x");
  assert.equal(unquote("'C:\\x'"), "C:\\x");
  assert.equal(unquote('"C:\\x'), '"C:\\x');
});
