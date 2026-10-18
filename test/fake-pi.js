"use strict";

/**
 * Scripted stand-in for `pi --mode rpc` used by tests (no model, no API key).
 *
 * Speaks the RPC protocol from docs/rpc.md + docs/json.md: JSONL commands on
 * stdin, responses and session events on stdout. Ignores CLI args such as
 * --mode rpc --no-session.
 *
 * Scenario: a single assistant turn that streams a `write` tool call for
 * hello.txt, emitting toolcall_delta chunks at a typing-like cadence. The
 * serialized-arguments JSON is split at awkward boundaries (mid-escape,
 * mid-\uXXXX) on purpose so consumers must handle partial JSON correctly.
 */

const CONTENT_LINES = [
	"# Hello from fake-pi",
	"",
	"This file is being streamed by the fake pi scenario.",
	"",
	"function haiku() {",
	"  return [",
	"    'quiet terminal',",
	"    'cursor watches code appear',",
	"    'stream of tokens\\n'",
	"  ];",
	"}",
	"",
	"console.log(haiku().join('\n')); // caf\u00e9 \u2028 \"quotes\" \\\\ done",
];

let timers = [];

function schedule(fn, ms) {
	const t = setTimeout(fn, ms);
	timers.push(t);
	return t;
}

function clearTimers() {
	for (const t of timers) clearTimeout(t);
	timers = [];
}

function readLines(stream, onLine) {
	let buf = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buf += chunk;
		for (;;) {
			const idx = buf.indexOf("\n");
			if (idx < 0) break;
			const line = buf.slice(0, idx).replace(/\r$/, "");
			buf = buf.slice(idx + 1);
			if (line) onLine(line);
		}
	});
}

function main() {
	let aborted = false;
	let exitScheduled = false;
	let respondToPrompt;

	const emit = (record) => {
		if (exitScheduled) return;
		process.stdout.write(JSON.stringify(record) + "\n");
	};

	respondToPrompt = (id) => {
		schedule(() => {
			emit({ type: "response", id, command: "prompt", success: true, data: { disposition: "started" } });
			runScenario();
		}, 30);
	};

	function runScenario() {
		if (aborted) return;
		const pathArg = "hello.txt";
		const content = CONTENT_LINES.join("\n");
		const serialized = JSON.stringify({ path: pathArg, content });

		emit({ type: "agent_start" });
		emit({ type: "turn_start" });
		emit({
			type: "message_start",
			message: { role: "assistant", content: [], stopReason: "pending", timestamp: Date.now() },
		});

		// Stream the serialized arguments in ~8-char chunks. A chunk size that
		// does not divide the JSON guarantees splits inside \n, \" and \u00e9
		// escape sequences.
		const CHUNK = 8;
		let delay = 15;
		for (let i = 0; i < serialized.length; i += CHUNK) {
			const delta = serialized.slice(i, i + CHUNK);
			const d = delta;
			schedule(() => {
				if (aborted) return;
				emit({
					type: "message_update",
					usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101 },
					assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: d },
				});
			}, delay);
			delay += 15;
		}

		const toolCall = {
			type: "toolCall",
			id: "call_fake_1",
			name: "write",
			arguments: { path: pathArg, content },
		};

		schedule(() => {
			if (aborted) return;
			emit({
				type: "message_update",
				usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 300 },
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall },
			});
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [toolCall],
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
			});
			emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: "write", args: toolCall.arguments });
			schedule(() => {
				if (aborted) return;
				emit({
					type: "tool_execution_end",
					toolCallId: toolCall.id,
					toolName: "write",
					result: { content: [{ type: "text", text: "ok" }], details: {} },
					isError: false,
					durationMs: 3,
				});
				emit({ type: "turn_end", message: { role: "assistant", content: [toolCall], stopReason: "toolUse" }, toolResults: [] });
				emit({ type: "agent_end", messages: [], willRetry: false });
				emit({ type: "agent_settled", aborted: false });
			}, 40);
		}, delay + 20);
	}

	readLines(process.stdin, (line) => {
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			process.stderr.write(`fake-pi: unparseable command: ${line.slice(0, 100)}\n`);
			return;
		}
		if (record.type === "prompt") {
			respondToPrompt(record.id);
		} else if (record.type === "abort") {
			aborted = true;
			clearTimers();
			schedule(() => {
				emit({ type: "response", id: record.id, command: "abort", success: true });
				emit({ type: "agent_settled", aborted: true });
			}, 40);
		}
		// get_state & others: intentionally ignored by the fake
	});

	process.stdin.on("end", () => {
		exitScheduled = true;
		clearTimers();
		process.exit(0);
	});

	process.on("SIGTERM", () => {
		clearTimers();
		process.exit(0);
	});
}

main();
