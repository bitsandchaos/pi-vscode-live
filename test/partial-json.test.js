"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { extractTopLevelStrings } = require("../lib/partial-json");

test("complete JSON: extracts all wanted string fields", () => {
	const src = '{"path":"a.ts","content":"hello\\nworld"}';
	const r = extractTopLevelStrings(src, ["path", "content"]);
	assert.equal(r.path, "a.ts");
	assert.equal(r.content, "hello\nworld");
});

test("truncated mid-content returns partial value", () => {
	const src = '{"path":"a.ts","content":"hello\\nwor';
	const r = extractTopLevelStrings(src, ["path", "content"]);
	assert.equal(r.path, "a.ts");
	assert.equal(r.content, "hello\nwor");
});

test("value not started yet -> null", () => {
	const r = extractTopLevelStrings('{"path":"a.ts","content":', ["path", "content"]);
	assert.equal(r.path, "a.ts");
	assert.equal(r.content, null);
});

test("key not closed yet -> null", () => {
	const r = extractTopLevelStrings('{"path":"a.ts","cont', ["path", "content"]);
	assert.equal(r.path, "a.ts");
	assert.equal(r.content, null);
});

test("key split across chunks -> null", () => {
	const r = extractTopLevelStrings('{"pat', ["path"]);
	assert.equal(r.path, null);
});

test("empty string value -> empty string", () => {
	const r = extractTopLevelStrings('{"content":""}', ["content"]);
	assert.equal(r.content, "");
});

test("content containing escaped quote and the literal text of other keys", () => {
	const src = '{"path":"x","content":"he said \\"path\\" and \\"content\\" out loud"}';
	const r = extractTopLevelStrings(src, ["path", "content"]);
	assert.equal(r.path, "x");
	assert.equal(r.content, 'he said "path" and "content" out loud');
});

test("truncation inside escaped quote", () => {
	const r = extractTopLevelStrings('{"content":"he said \\"pa', ["content"]);
	assert.equal(r.content, 'he said "pa');
});

test("edit shape with oldText before newText", () => {
	const src = '{"path":"x.ts","oldText":"foo","newText":"bar\\nba';
	const r = extractTopLevelStrings(src, ["path", "oldText", "newText"]);
	assert.equal(r.path, "x.ts");
	assert.equal(r.oldText, "foo");
	assert.equal(r.newText, "bar\nba");
});

test("fields before the wanted field are skipped (number, bool, null, nested)", () => {
	const src = '{"n":42,"ok":true,"nope":null,"meta":{"a":"}"},"content":"x';
	const r = extractTopLevelStrings(src, ["content"]);
	assert.equal(r.content, "x");
});

test("truncated number before wanted field -> null", () => {
	const r = extractTopLevelStrings('{"n":4', ["content"]);
	assert.equal(r.content, null);
});

test("truncated \\uXXXX escape waits for more data", () => {
	const r = extractTopLevelStrings('{"content":"caf\\u00', ["content"]);
	assert.equal(r.content, "caf");
});

test("complete \\uXXXX escape decodes", () => {
	const r = extractTopLevelStrings('{"content":"caf\\u00e9"}', ["content"]);
	assert.equal(r.content, "caf\u00e9");
});

test("U+2028/U+2029 inside strings pass through untouched", () => {
	const src = '{"content":"a b"}';
	const r = extractTopLevelStrings(src, ["content"]);
	assert.equal(r.content, "a b");
});

test("whitespace between tokens tolerated", () => {
	const src = '{ "path" : "a" , "content" : "b\\nc" }';
	const r = extractTopLevelStrings(src, ["path", "content"]);
	assert.equal(r.path, "a");
	assert.equal(r.content, "b\nc");
});

test("truncated nested object before wanted field -> null", () => {
	const r = extractTopLevelStrings('{"meta":{"a":{"b":1', ["content"]);
	assert.equal(r.content, null);
});

test("non-object input -> all null", () => {
	const r = extractTopLevelStrings("[1,2", ["content"]);
	assert.equal(r.content, null);
	const r2 = extractTopLevelStrings("", ["content"]);
	assert.equal(r2.content, null);
});

test("unicode field names not requested are skipped safely", () => {
	const src = '{"caf\\u00e9":"skip me","content":"got"}';
	const r = extractTopLevelStrings(src, ["content"]);
	assert.equal(r.content, "got");
});
