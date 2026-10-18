"use strict";

const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const { EventEmitter } = require("events");

/**
 * JSONL client for `pi --mode rpc` (see docs/rpc.md).
 *
 * - Strict LF framing: records are split on \n only, an optional preceding
 *   \r is stripped. Node's readline is NOT used because it also splits on
 *   U+2028/U+2029, which are valid inside JSON strings.
 * - stdout is consumed continuously (a stalled reader can stall Pi).
 * - Commands are correlated by the optional `id` field; responses resolve
 *   the matching request. Everything else is re-emitted as "event".
 * - stderr is captured as a bounded tail for diagnostics; it is never
 *   parsed as protocol data.
 */
class PiRpcClient extends EventEmitter {
	/**
	 * @param {{ command: string, args?: string[], cwd?: string, env?: object }} opts
	 */
	constructor(opts) {
		super();
		this.command = opts.command;
		this.args = opts.args || [];
		this.cwd = opts.cwd;
		this.env = opts.env;
		this._proc = null;
		this._buf = "";
		this._decoder = new StringDecoder("utf8");
		this._nextId = 1;
		this._pending = new Map(); // id -> { resolve, reject, timer }
		this._stderrLines = [];
		this._exited = false;
	}

	/** Spawn the pi process. Resolves once the process is running. */
	start() {
		return new Promise((resolve, reject) => {
			let settled = false;
			let proc;
			try {
				proc = spawn(this.command, this.args, {
					cwd: this.cwd,
					env: this.env ? { ...process.env, ...this.env } : process.env,
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (err) {
				reject(err);
				return;
			}
			this._proc = proc;

			proc.on("error", (err) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
				this._failPending(err);
				this.emit("log", `process error: ${err.message}`);
			});

			proc.stdout.on("data", (chunk) => this._onStdout(chunk));
			proc.stderr.on("data", (chunk) => this._onStderr(chunk));

			proc.on("exit", (code, signal) => {
				this._exited = true;
				this._failPending(
					new Error(`pi exited unexpectedly (code=${code} signal=${signal})${this._stderrTailText()}`)
				);
				this.emit("exit", code, signal);
			});

			settled = true;
			resolve();
		});
	}

	/** Send a record without expecting a correlated response (e.g. abort). */
	send(record) {
		if (!this._proc || this._exited) throw new Error("pi process is not running");
		this._proc.stdin.write(JSON.stringify(record) + "\n");
	}

	/**
	 * Send a command and wait for its correlated response.
	 * @param {object} body command record without `id`
	 * @param {{ timeoutMs?: number }} opts
	 * @returns {Promise<object>} the response record
	 */
	request(body, { timeoutMs = 120000 } = {}) {
		const id = `req-${this._nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new Error(`pi command timed out after ${timeoutMs}ms: ${body.type}`));
			}, timeoutMs);
			this._pending.set(id, {
				resolve: (record) => {
					clearTimeout(timer);
					resolve(record);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});
			try {
				this.send({ id, ...body });
			} catch (err) {
				this._pending.delete(id);
				clearTimeout(timer);
				reject(err);
			}
		});
	}

	/** Resolve with the next agent_settled event (docs: signals no remaining automatic work). */
	waitForSettled({ timeoutMs = 600000 } = {}) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.removeListener("event", onEvent);
				reject(new Error(`timed out waiting for agent_settled after ${timeoutMs}ms`));
			}, timeoutMs);
			const onEvent = (record) => {
				if (record.type !== "agent_settled") return;
				clearTimeout(timer);
				this.removeListener("event", onEvent);
				resolve(record);
			};
			this.on("event", onEvent);
		});
	}

	/** Graceful stop: close stdin, then SIGTERM if the process lingers. */
	async stop() {
		const proc = this._proc;
		if (!proc || this._exited) return;
		await new Promise((resolve) => {
			const done = () => resolve();
			proc.once("exit", done);
			try {
				proc.stdin.end();
			} catch {
				/* already gone */
			}
			setTimeout(() => {
				if (!this._exited) {
					this.emit("log", "did not exit after stdin close — sending SIGTERM");
					try {
						proc.kill("SIGTERM");
					} catch {
						/* already gone */
					}
				}
			}, 2000);
			setTimeout(done, 5000); // never hang the caller
		});
	}

	kill() {
		if (this._proc && !this._exited) {
			try {
				this._proc.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}
	}

	_onStdout(chunk) {
		this._buf += this._decoder.write(chunk);
		for (;;) {
			const idx = this._buf.indexOf("\n");
			if (idx < 0) break;
			let line = this._buf.slice(0, idx);
			this._buf = this._buf.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			this._handleLine(line);
		}
	}

	_handleLine(line) {
		let record;
		try {
			record = JSON.parse(line);
		} catch (err) {
			this.emit("log", `unparseable stdout record (${err.message}): ${line.slice(0, 200)}`);
			return;
		}
		if (record && record.type === "response" && typeof record.id === "string") {
			const pending = this._pending.get(record.id);
			if (pending) {
				this._pending.delete(record.id);
				if (record.success) pending.resolve(record);
				else pending.reject(new Error(record.error || "pi command failed"));
			} else {
				this.emit("log", `response with unknown id ignored: ${record.id}`);
			}
			return;
		}
		this.emit("event", record);
	}

	_onStderr(chunk) {
		const text = chunk.toString("utf8");
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			this._stderrLines.push(line);
			if (this._stderrLines.length > 50) this._stderrLines.shift();
			this.emit("log", `[stderr] ${line}`);
		}
	}

	_stderrTailText() {
		return this._stderrLines.length ? ` stderr: ${this._stderrLines.slice(-5).join(" | ")}` : "";
	}

	_failPending(err) {
		for (const pending of this._pending.values()) pending.reject(err);
		this._pending.clear();
	}
}

module.exports = { PiRpcClient };
