"use strict";

/**
 * Progressive extraction of top-level string fields from partially streamed JSON.
 *
 * Pi's RPC stream (docs/json.md) delivers tool-call arguments as serialized JSON
 * in chunks via `toolcall_delta` events. To render a file while it is being
 * written we need the value of a string field before the JSON is complete, e.g.
 * from
 *
 *   {"path":"src/a.ts","content":"export function m() {\n  ret
 *
 * we want content === 'export function m() {\n  ret' (best-effort unescaped).
 *
 * This is a best-effort extractor: the authoritative value always arrives later
 * in `toolcall_end` (complete ToolCall.arguments) or `tool_execution_end`.
 */

const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * Best-effort unescape of a raw JSON string body (text between the quotes,
 * possibly truncated mid-escape). Anything after a dangling backslash or a
 * truncated \uXXXX sequence is dropped — more data will arrive in the next
 * delta and the extraction re-runs.
 */
function unescapeChunk(raw) {
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = raw[i + 1];
		if (next === undefined) break; // dangling escape at buffer end
		if (next === "u") {
			const hex = raw.slice(i + 2, i + 6);
			if (hex.length < 4) break; // truncated \uXXXX
			const code = Number.parseInt(hex, 16);
			if (!Number.isNaN(code)) out += String.fromCharCode(code);
			i += 5;
			continue;
		}
		out += ESCAPES[next] !== undefined ? ESCAPES[next] : next; // unknown escape: keep literally
		i += 1;
	}
	return out;
}

/**
 * Read a JSON string body starting just after its opening quote.
 * Returns { body, endIdx, closed } — closed=false when the buffer ended
 * before the closing quote (value still streaming).
 */
function readStringBody(source, start) {
	let i = start;
	let body = "";
	while (i < source.length) {
		const ch = source[i];
		if (ch === "\\") {
			body += ch;
			if (i + 1 < source.length) {
				body += source[i + 1];
				i += 2;
			} else {
				i += 1;
			}
			continue;
		}
		if (ch === '"') return { body, endIdx: i + 1, closed: true };
		body += ch;
		i += 1;
	}
	return { body, endIdx: source.length, closed: false };
}

/**
 * Skip one JSON value (any type) starting at index i, tolerating values
 * nested in strings. Returns the index just after the value, or -1 if the
 * value is incomplete (buffer truncated).
 */
function skipValue(source, i) {
	const len = source.length;
	if (i >= len) return -1;
	const ch = source[i];
	if (ch === '"') {
		const str = readStringBody(source, i + 1);
		return str.closed ? str.endIdx : -1;
	}
	if (ch === "{" || ch === "[") {
		const open = ch;
		const close = ch === "{" ? "}" : "]";
		let depth = 0;
		while (i < len) {
			const c = source[i];
			if (c === '"') {
				const str = readStringBody(source, i + 1);
				if (!str.closed) return -1;
				i = str.endIdx;
				continue;
			}
			if (c === open) depth++;
			else if (c === close) {
				depth--;
				i++;
				if (depth === 0) return i;
				continue;
			}
			i++;
		}
		return -1;
	}
	// number / true / false / null: scan to a delimiter; hitting the buffer
	// end first means the literal may still be growing
	while (i < len) {
		const c = source[i];
		if (c === "," || c === "}" || c === "]") return i;
		i++;
	}
	return -1;
}

/**
 * Extract top-level string fields from a partially streamed JSON object.
 *
 * @param {string} source accumulated serialized arguments (partial JSON)
 * @param {string[]} fieldNames field names of interest
 * @returns {Record<string, string|null>} field -> best-effort current value;
 *   null when the field has not produced a string value yet (key still
 *   streaming, value not started, or non-string value).
 */
function extractTopLevelStrings(source, fieldNames) {
	const wanted = new Set(fieldNames);
	const result = Object.create(null);
	for (const name of fieldNames) result[name] = null;

	const len = source.length;
	let i = 0;
	while (i < len && /\s/.test(source[i])) i++;
	if (source[i] !== "{") return result; // not an object (yet)
	i++;

	while (i < len) {
		while (i < len && /\s/.test(source[i])) i++;
		if (source[i] === "}" || source[i] === undefined) break;
		if (source[i] !== '"') break; // malformed or mid-chunk — wait for more
		const key = readStringBody(source, i + 1);
		if (!key.closed) break; // key still streaming
		i = key.endIdx;
		while (i < len && /\s/.test(source[i])) i++;
		if (source[i] !== ":") break; // incomplete
		i++;
		while (i < len && /\s/.test(source[i])) i++;

		if (wanted.has(key.body)) {
			if (source[i] === '"') {
				const val = readStringBody(source, i + 1);
				result[key.body] = unescapeChunk(val.body);
				if (!val.closed) break; // value truncated — nothing more to extract
				i = val.endIdx;
			} else {
				// present but not a string (null / number / bool / nested) — leave null
				const next = skipValue(source, i);
				if (next < 0) break;
				i = next;
			}
		} else {
			const next = skipValue(source, i);
			if (next < 0) break; // truncated mid-value
			i = next;
		}

		while (i < len && /\s/.test(source[i])) i++;
		if (source[i] === ",") {
			i++;
			continue;
		}
		break; // '}' or end — done
	}
	return result;
}

module.exports = { extractTopLevelStrings };
