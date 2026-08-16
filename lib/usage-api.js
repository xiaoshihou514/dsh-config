import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
//#region src/usage-api.ts
/** Durable DeepSeek-official token accounting and its same-origin read API. */
const name = "dsh-config-usage-api";
const inject = ["sessions", "webServer"];
const ROUTE = "/dsh-config/usage";
const HEADER = "x-dsh-config";
const HEADER_VALUE = "usage-calendar";
const PROVIDER = "deepseek-official";
function dataPath() {
	return join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "dsh-config", "usage.json");
}
function modelFor(header) {
	if (header?.provider !== PROVIDER) return void 0;
	return header.model === "deepseek-v4-pro" || header.model === "deepseek-v4-flash" ? header.model : void 0;
}
function projectName(cwd) {
	return cwd === void 0 ? "未指定项目" : basename(cwd) || cwd;
}
async function load(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			const candidate = parsed;
			if (candidate.version === 1 && Array.isArray(candidate.records)) return {
				version: 1,
				records: candidate.records.filter(isRecord)
			};
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return {
		version: 1,
		records: []
	};
}
function isRecord(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value;
	return typeof record.id === "string" && typeof record.at === "number" && typeof record.project === "string" && (record.model === "deepseek-v4-flash" || record.model === "deepseek-v4-pro") && [
		record.inputTokens,
		record.outputTokens,
		record.cacheReadTokens,
		record.cacheWriteTokens
	].every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0);
}
async function save(path, value) {
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	await rename(temporary, path);
}
/** Last header per session, used to attribute its following usage event. */
function apply(ctx) {
	const headers = /* @__PURE__ */ new WeakMap();
	const pending = /* @__PURE__ */ new Map();
	const path = dataPath();
	let file = load(path);
	let writes = Promise.resolve();
	const account = (session, event) => {
		if (event.type === "request/header") {
			headers.set(session, event.data.header.config);
			return;
		}
		let usage;
		let turn;
		let step;
		if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") {
			usage = event.data.chunk.usage;
			turn = event.data.turn;
			step = event.data.step;
		} else if (event.type === "assistant/message" && event.data.usage !== void 0) {
			usage = event.data.usage;
			turn = event.data.turn;
			step = event.data.step;
		}
		if (usage === void 0 || turn === void 0 || step === void 0) return;
		const model = modelFor(headers.get(session));
		if (model === void 0) return;
		const id = `${session.id}:${turn}:${step}`;
		pending.set(id, {
			id,
			at: event.time,
			project: projectName(session.header.cwd),
			model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens ?? 0,
			cacheWriteTokens: usage.cacheWriteTokens ?? 0
		});
		writes = writes.then(async () => {
			const next = await file;
			const record = pending.get(id);
			if (record === void 0) return;
			const index = next.records.findIndex((entry) => entry.id === id);
			if (index >= 0) next.records[index] = record;
			else next.records.push(record);
			pending.delete(id);
			file = Promise.resolve(next);
			await save(path, next);
		}).catch((error) => {
			ctx.logger("dsh-config").warn("无法保存 Token 用量：%s", error instanceof Error ? error.message : String(error));
		});
	};
	ctx.on("session/event", account);
	const route = {
		kind: "exact",
		path: ROUTE,
		handler: async (request, response) => {
			if (request.headers[HEADER] !== HEADER_VALUE) {
				response.writeHead(403).end();
				return;
			}
			if (request.method !== "GET") {
				response.writeHead(405).end();
				return;
			}
			await writes;
			const current = await file;
			response.writeHead(200, {
				"cache-control": "no-store",
				"content-type": "application/json; charset=utf-8",
				"x-content-type-options": "nosniff"
			});
			response.end(JSON.stringify({
				ok: true,
				records: current.records
			}));
		}
	};
	ctx.effect(() => ctx.webServer.register(route), "dsh-config: token calendar API");
}
//#endregion
export { apply, inject, name };
