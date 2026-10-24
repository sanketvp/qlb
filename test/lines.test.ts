import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindingWindow,
  lineHeadroom,
  windowLine,
  type UsageWindow,
} from '../src/lines';

const windows = (fiveHour: number, sevenDay: number): UsageWindow[] => [
  ['5h', fiveHour, '2026-01-01T01:00:00Z'],
  ['7d', sevenDay, '2026-01-05T00:00:00Z'],
];

// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — test_lines.py

test('5h always takes threshold', () => {
  assert.equal(windowLine('5h', 85, 97), 85);
});
test('weekly and scoped labels take weekly line', () => {
  assert.equal(windowLine('7d', 85, 97), 97);
  assert.equal(windowLine('Fable', 85, 97), 97);
});
test('unset weekly line falls back everywhere', () => {
  for (const label of ['5h', '7d', 'Fable']) assert.equal(windowLine(label, 85, undefined), 85);
});
test('equal lines are raw headroom exactly', () => {
  for (const pct of [0, 50.5, 100]) assert.equal(lineHeadroom(pct, 90, 90), 100 - pct);
});
test('integer anchors are exact', () => {
  assert.equal(lineHeadroom(0, 97, 85), 100);
  assert.equal(lineHeadroom(97, 97, 85), 15);
  assert.equal(lineHeadroom(100, 97, 85), 0);
});
test('decimal line and exhaustion anchors are exact', () => {
  assert.equal(lineHeadroom(86.3, 86.3, 92.7), 7.299999999999997);
  assert.equal(lineHeadroom(100, 86.3, 92.7), 0);
});
test('under weekly line is linearly rescaled', () => {
  assert.equal(lineHeadroom(93, 97, 85), 15 + (85 * 4) / 97);
});
test('over weekly line is linearly rescaled', () => {
  assert.equal(lineHeadroom(98, 97, 85), 10);
  assert.equal(lineHeadroom(99, 97, 85), 5);
});
test('a weekly line below 5h line scales both bands', () => {
  assert.equal(lineHeadroom(85, 80, 90), 7.5);
});
test('line boundary avoids rescale residue', () => {
  assert.equal(lineHeadroom(86, 86, 92), 8);
});
test('headroom is monotonic as pct rises', () => {
  assert.ok(lineHeadroom(80, 97, 85) >= lineHeadroom(81, 97, 85));
});
test('least policy headroom binds, not highest pct', () => {
  const found = bindingWindow(windows(5, 93), 85, 97)!;
  assert.deepEqual([found.label, found.pct, found.line, found.over], ['7d', 93, 97, false]);
});
test('over uses direct comparison at line', () => {
  assert.equal(bindingWindow(windows(5, 97), 85, 97)!.over, true);
  assert.equal(bindingWindow(windows(5, 96.9), 85, 97)!.over, false);
});
test('ties retain first window', () => {
  assert.equal(bindingWindow(windows(0, 0), 90)!.label, '5h');
});
test('no windows yields undefined', () => {
  assert.equal(bindingWindow([], 85, 97), undefined);
});
test('resetsAt travels with binding window', () => {
  assert.equal(bindingWindow(windows(90, 93), 85, 97)!.resetsAt, '2026-01-01T01:00:00Z');
});
test('scoped windows take weekly line', () => {
  const found = bindingWindow([['5h', 5, undefined], ['Fable', 96, undefined]], 85, 97)!;
  assert.deepEqual([found.label, found.line, found.over], ['Fable', 97, false]);
});
test('weekly unset matches max-pct rule', () => {
  const found = bindingWindow(windows(81, 92), 90)!;
  assert.deepEqual([found.label, found.pct, found.lineHeadroom, found.over], ['7d', 92, 8, true]);
});
test('binding over matches any window over its line', () => {
  assert.equal(bindingWindow(windows(86, 96), 85, 97)!.over, true);
});
test('binding headroom is the minimum policy headroom', () => {
  const found = bindingWindow(windows(80, 96), 85, 97)!;
  assert.equal(found.lineHeadroom, Math.min(lineHeadroom(80, 85, 85), lineHeadroom(96, 97, 85)));
});
test('binding flip has no score discontinuity', () => {
  assert.equal(bindingWindow(windows(86.7, 99), 85, 97)!.lineHeadroom, 5);
  assert.equal(bindingWindow(windows(86.8, 99), 85, 97)!.lineHeadroom, 5);
});
test('scale measures room on a shared ruler', () => {
  assert.equal(bindingWindow([['5h', 50, undefined]], 60, undefined, { scale: 90 })!.lineHeadroom, 25);
});
test('without scale each line is its own ruler', () => {
  assert.equal(bindingWindow([['5h', 50, undefined]], 60)!.lineHeadroom, 50);
});
test('scale changes only room, not window facts', () => {
  const plain = bindingWindow([['5h', 50, 'x']], 60)!;
  const scaled = bindingWindow([['5h', 50, 'x']], 60, undefined, { scale: 90 })!;
  assert.deepEqual(
    [scaled.label, scaled.pct, scaled.line, scaled.resetsAt, scaled.over],
    [plain.label, plain.pct, plain.line, plain.resetsAt, plain.over],
  );
});
test('scale can change tie-breaking binding window', () => {
  const input: UsageWindow[] = [['5h', 73.3, undefined], ['7d', 94, undefined]];
  assert.equal(bindingWindow(input, 55.5, 90, { scale: 90 })!.label, '5h');
  assert.equal(bindingWindow(input, 55.5, 90)!.label, '7d');
});
