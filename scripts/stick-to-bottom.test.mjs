// The chat thread's follow-the-bottom state (0.20): only the reader's own
// upward gesture unpins; scroll events — content growth, our own scrollTop
// writes, a hidden pane — can only re-pin.

import test from "node:test";
import assert from "node:assert/strict";
import { afterUpIntent, afterScroll, afterRelease, showJump } from "../src/lib/stickToBottom.ts";

const at = (scrollTop, scrollHeight = 2000, clientHeight = 800) => ({ scrollTop, scrollHeight, clientHeight });
const BOTTOM = 1200;

test("content growth while pinned stays pinned and shows no button", () => {
  // Content grew by 500px before we snapped: the scroll event (anchoring, or
  // our own write) reads far from the bottom, but a scroll event never unpins.
  assert.equal(afterScroll(true, at(BOTTOM), at(BOTTOM, 2500)), true);
  assert.equal(afterScroll(true, at(BOTTOM), at(BOTTOM - 300, 2500)), true);
  assert.equal(showJump(true, at(BOTTOM, 2500)), false);
});

test("a programmatic scroll does not unpin", () => {
  // Our snap to the bottom, or a clamp after content shrank: either direction.
  assert.equal(afterScroll(true, at(BOTTOM), at(BOTTOM + 400, 2400)), true);
  assert.equal(afterScroll(true, at(BOTTOM), at(BOTTOM - 200, 1800)), true);
});

test("wheel up unpins, and the smooth scroll it starts does not re-pin", () => {
  let pinned = afterUpIntent(true, at(BOTTOM));
  assert.equal(pinned, false);
  // First frames of the animation are still within the threshold, moving up.
  pinned = afterScroll(pinned, at(BOTTOM), at(BOTTOM - 10));
  pinned = afterScroll(pinned, at(BOTTOM - 10), at(BOTTOM - 40));
  assert.equal(pinned, false);
  assert.equal(showJump(pinned, at(BOTTOM - 40)), false, "too close to offer the button yet");
  assert.equal(showJump(pinned, at(BOTTOM - 300)), true);
  // Streaming continues underneath: still unpinned, button stays.
  assert.equal(afterScroll(pinned, at(BOTTOM - 300), at(BOTTOM - 300, 2600)), false);
});

test("an upward gesture with nowhere to go leaves it pinned", () => {
  assert.equal(afterUpIntent(true, at(0, 500, 800)), true, "short chat, nothing to scroll");
});

test("scrolling back down near the bottom re-pins; far away does not", () => {
  assert.equal(afterScroll(false, at(800), at(BOTTOM - 30)), true);
  assert.equal(afterScroll(false, at(800), at(1000)), false);
});

test("letting go of the scrollbar near the bottom re-pins", () => {
  assert.equal(afterRelease(false, at(BOTTOM - 20)), true);
  assert.equal(afterRelease(false, at(400)), false);
});

test("a hidden (0-tall) pane neither unpins nor shows the button", () => {
  const gone = at(0, 2000, 0);
  assert.equal(afterUpIntent(true, gone), true);
  assert.equal(afterScroll(true, at(BOTTOM), gone), true);
  assert.equal(afterScroll(false, at(BOTTOM - 300), gone), false);
  assert.equal(showJump(false, gone), false);
});

test("the button shows only when unpinned and far from the bottom", () => {
  assert.equal(showJump(true, at(0)), false);
  assert.equal(showJump(false, at(BOTTOM - 20)), false);
  assert.equal(showJump(false, at(0)), true);
});
