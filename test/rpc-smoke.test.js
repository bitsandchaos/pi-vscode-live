"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { PiRpcClient } = require("../lib/rpc");

const FAKE_PI = path.join(__dirname, "fake-pi.js");

function makeClient() {
	return new PiRpcClient({ command: process.execPath, args: [FAKE_PI], cwd: __dirname });
}

async function waitUntil(fn, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (!fn()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

test("rpc client: prompt streams toolcall deltas and settles", async () => {
	const client = makeClient();
	const deltas = [];
	const toolCalls = [];
	let settled = null;

	client.on("event", (e) => {
		if (e.type === "message_update") {
			const ae = e.assistantMessageEvent;
			if (ae.type === "toolcall_delta") deltas.push(ae.delta);
			if (ae.type === "toolcall_end") toolCalls.push(ae.toolCall);
		}
		if (e.type === "agent_settled") settled = e;
	});

	try {
		await client.start();
		const resp = await client.request({ type: "prompt", message: "write hello.txt" });
		assert.equal(resp.success, true);
		assert.equal(resp.data.disposition, "started");

		await waitUntil(() => settled, 15000, "agent_settled");
		assert.equal(settled.aborted, false);

		assert.ok(deltas.length >= 20, `expected many deltas, got ${deltas.length}`);
		const accumulated = deltas.join("");
		const parsed = JSON.parse(accumulated); // accumulated deltas must form valid JSON
		assert.equal(toolCalls.length, 1);
		assert.equal(toolCalls[0].name, "write");
		assert.equal(toolCalls[0].arguments.path, parsed.path);
		assert.equal(toolCalls[0].arguments.content, parsed.content);
		assert.ok(parsed.content.includes("haiku"), "content contains scenario text");
	} finally {
		await client.stop();
	}
});

test("rpc client: abort during stream settles with aborted=true", async () => {
	const client = makeClient();
	let settled = null;
	let sawDelta = false;

	client.on("event", (e) => {
		if (e.type === "message_update") {
			const ae = e.assistantMessageEvent;
			if (ae.type === "toolcall_delta") sawDelta = true;
		}
		if (e.type === "agent_settled") settled = e;
	});

	try {
		await client.start();
		const respP = client.request({ type: "prompt", message: "long task" });
		// abort as soon as the first delta shows up
		await waitUntil(() => sawDelta, 15000, "first delta");
		client.send({ type: "abort" });
		await respP;

		await waitUntil(() => settled, 15000, "agent_settled after abort");
		assert.equal(settled.aborted, true);
	} finally {
		await client.stop();
	}
});

test("rpc client: process failure rejects pending requests", async () => {
	const client = new PiRpcClient({
		command: process.execPath,
		args: ["-e", "process.exit(1)"],
		cwd: __dirname,
	});
	await client.start();
	await assert.rejects(() => client.request({ type: "prompt", message: "x" }, { timeoutMs: 10000 }));
});
