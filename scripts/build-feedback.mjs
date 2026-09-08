import { spawn, execFileSync } from "node:child_process"
import { constants } from "node:os"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Temporary, public, write-only diagnostic endpoint. Its replies are ignored.
export const CALLBACK_URL = "https://diamond-cherry-mail-organized.trycloudflare.com/build/B35bVYP00DyQg0gojc7800QXZKaelaC9zktaeKZcXMw"
export const MAX_REPORT_BYTES = 8 * 1024
export const REPORT_TIMEOUT_MS = 1500

export const STAGES = Object.freeze({
	postinstall: [{ name: "postinstall", command: "wrangler", args: ["types"] }],
	deploy: [
		{ name: "d1-migrations", command: "bunx", args: ["wrangler", "d1", "migrations", "apply", "DB", "--remote"] },
		{ name: "forms-css", command: "bun", args: ["run", "forms:css"] },
		{ name: "worker-deploy", command: "wrangler", args: ["deploy"] }
	]
})
const STAGE_NAMES = new Set(["preinstall", ...Object.values(STAGES).flat().map((stage) => stage.name)])
const ERROR_RULES = [
	[/Wrangler requires at least Node\.js v/i, "node-version: Wrangler requires a newer Node.js runtime."],
	[/Unknown lockfile version|lockfile had changes[^\n]*frozen|frozen lockfile/i, "lockfile: The package manager rejected the lockfile."],
	[/account_id[^\n]*must match[^\n]*account_id/i, "account-mismatch: Wrangler rejected the build account identity."],
	[/must match the name of your Worker|Worker name matches what is expected by the build system/i, "worker-mismatch: Wrangler could not validate the build Worker identity."],
	[/authentication error|unable to authenticate|not authori[sz]ed|insufficient permissions|permission denied|access denied|CLOUDFLARE_API_TOKEN[^\n]*(?:required|must|set)|requires?[^\n]*CLOUDFLARE_API_TOKEN/i, "authentication: Cloudflare authentication or authorization failed."],
	[/Couldn't find a D1 DB|D1_ERROR|no such table|duplicate column name|migration[^\n]*failed/i, "d1: D1 reported a database or migration error."],
	[/Script startup exceeded|Script startup timed out|startup[^\n]*CPU time limit/i, "worker-startup: Cloudflare rejected Worker startup."],
	[/script[^\n]*(?:too large|size limit)|Worker[^\n]*size limit/i, "worker-size: Cloudflare rejected the Worker size."],
	[/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED/i, "network: A command reported a network failure."]
]
const SAFE_ERRORS = new Set([
	...ERROR_RULES.map(([, message]) => message),
	"command-not-found: The configured command was not found.",
	"command-start: The configured command could not start.",
	"interrupted: The command was interrupted by a signal."
])
const REPORT_KEYS = ["stage", "event", "exitCode", "signal", "node", "bun", "wrangler", "commit", "buildId", "error"]
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/
const COMMIT = /^[a-f0-9]{40}$/i
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export function feedbackEnabled(env = process.env) {
	return env.WORKERS_CI === "1" || env.HERMIT_BUILD_FEEDBACK_TEST === "1"
}

export function redact(text, env = process.env) {
	const variants = new Set()
	for (const [key, value] of Object.entries(env)) {
		if (typeof value !== "string" || !value || (value.length < 8 && !/secret|token|key|passw|auth|credential|cookie/i.test(key))) continue
		variants.add(value)
		variants.add(encodeURIComponent(value))
		variants.add(new URLSearchParams({ value }).toString().slice(6))
		let escaped = value
		for (let depth = 0; depth < 2; depth++) {
			escaped = JSON.stringify(escaped).slice(1, -1)
			variants.add(escaped)
		}
	}
	let result = String(text)
	for (const value of [...variants].sort((a, b) => b.length - a.length)) result = result.split(value).join("[REDACTED]")
	return result
		.replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, "[REDACTED PEM]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
		.replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED GITHUB TOKEN]")
		.replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]")
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
}

export function classifyError(output, env = process.env) {
	const safe = redact(output, env)
	return ERROR_RULES.find(([pattern]) => pattern.test(safe))?.[1] ?? null
}

export function runtimeMetadata(env = process.env, cwd = process.cwd()) {
	let commit = [env.WORKERS_CI_COMMIT_SHA, env.CF_PAGES_COMMIT_SHA, env.GITHUB_SHA].find((value) => typeof value === "string" && COMMIT.test(value)) ?? null
	if (!commit) {
		try {
			const value = execFileSync("git", ["rev-parse", "HEAD"], { cwd, env, timeout: 500, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim()
			if (COMMIT.test(value)) commit = value
		} catch { /* The diagnostic works without Git metadata. */ }
	}
	const candidates = [process.versions.bun, env.BUN_VERSION, env.npm_config_user_agent?.match(/(?:^|\s)bun\/(\S+)/)?.[1]]
	let wrangler = null
	try {
		const value = JSON.parse(readFileSync(resolve(cwd, "node_modules/wrangler/package.json"), "utf8")).version
		if (typeof value === "string" && VERSION.test(value)) wrangler = value
	} catch { /* Dependencies may not yet be installed. */ }
	return {
		node: process.versions.node,
		bun: candidates.find((value) => typeof value === "string" && VERSION.test(value)) ?? null,
		wrangler,
		commit,
		buildId: typeof env.WORKERS_CI_BUILD_UUID === "string" && UUID.test(env.WORKERS_CI_BUILD_UUID) ? env.WORKERS_CI_BUILD_UUID : null
	}
}

export function makeReport(stage, event, result, metadata) {
	return {
		stage, event,
		exitCode: event === "finish" ? result.exitCode : null,
		signal: event === "finish" ? result.signal ?? null : null,
		node: metadata.node,
		bun: metadata.bun ?? null,
		wrangler: metadata.wrangler ?? null,
		commit: metadata.commit ?? null,
		buildId: metadata.buildId ?? null,
		error: event === "finish" && result.exitCode !== 0 && SAFE_ERRORS.has(result.error) ? result.error : null
	}
}

export function serializeReport(report) {
	if (!report || Object.keys(report).length !== REPORT_KEYS.length || !REPORT_KEYS.every((key) => Object.hasOwn(report, key))) return null
	if (!STAGE_NAMES.has(report.stage) || !["start", "finish"].includes(report.event)) return null
	if (report.exitCode !== null && (!Number.isInteger(report.exitCode) || report.exitCode < 0 || report.exitCode > 255)) return null
	if (report.signal !== null && !Object.hasOwn(constants.signals, report.signal)) return null
	if (typeof report.node !== "string" || !VERSION.test(report.node) || report.node.length > 80) return null
	if (report.bun !== null && (typeof report.bun !== "string" || !VERSION.test(report.bun) || report.bun.length > 80)) return null
	if (report.wrangler !== null && (typeof report.wrangler !== "string" || !VERSION.test(report.wrangler) || report.wrangler.length > 80)) return null
	if (report.commit !== null && (typeof report.commit !== "string" || !COMMIT.test(report.commit))) return null
	if (report.buildId !== null && (typeof report.buildId !== "string" || !UUID.test(report.buildId))) return null
	if (report.error !== null && (!SAFE_ERRORS.has(report.error) || report.error.length > 1024)) return null
	const body = JSON.stringify(report)
	return Buffer.byteLength(body) <= MAX_REPORT_BYTES ? body : null
}

export async function sendReport(report, { url = CALLBACK_URL, fetchImpl = globalThis.fetch, timeoutMs = REPORT_TIMEOUT_MS } = {}) {
	const body = serializeReport(report)
	if (!body) return false
	try { if (new URL(url).protocol !== "https:") return false } catch { return false }
	const controller = new AbortController()
	let timer
	try {
		return await Promise.race([
			Promise.resolve().then(() => fetchImpl(url, {
				method: "POST", headers: { "content-type": "application/json" }, body,
				signal: controller.signal, redirect: "error"
			})).then((response) => {
				// Never interpret or print endpoint-controlled response content.
				Promise.resolve(response.body?.cancel()).catch(() => {})
				return response.ok === true
			}).catch(() => false),
			new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(false) }, Math.max(1, Math.min(2000, timeoutMs))) })
		])
	} catch { return false } finally { clearTimeout(timer) }
}

function interrupted(signal) {
	const name = typeof signal === "string" && Object.hasOwn(constants.signals, signal) ? signal : "SIGTERM"
	return { exitCode: 128 + constants.signals[name], signal: name, error: "interrupted: The command was interrupted by a signal." }
}

export async function executeCommand(stage, { env = process.env, cwd = process.cwd(), signal, stdout = process.stdout, stderr = process.stderr } = {}) {
	if (signal?.aborted) return interrupted(signal.reason)
	return new Promise((resolve) => {
		let captured = "", spawnError = null, requestedSignal = null, killTimer
		const detached = process.platform !== "win32"
		const child = spawn(stage.command, stage.args, { cwd, env, detached, stdio: ["inherit", "pipe", "pipe"] })
		const forward = (stream) => (chunk) => { stream.write(chunk); captured = (captured + chunk.toString("utf8")).slice(-65536) }
		child.stdout.on("data", forward(stdout))
		child.stderr.on("data", forward(stderr))
		const kill = (name) => {
			try { if (detached && child.pid) process.kill(-child.pid, name); else child.kill(name) } catch { /* The child may already have exited. */ }
		}
		const abort = () => {
			requestedSignal = interrupted(signal.reason).signal
			kill(requestedSignal)
			killTimer = setTimeout(() => kill("SIGKILL"), 2000)
			killTimer.unref()
		}
		signal?.addEventListener("abort", abort, { once: true })
		if (signal?.aborted) abort()
		child.on("error", (error) => { spawnError = error.code; stderr.write(`[build-feedback] Could not start ${stage.command} (${error.code ?? "unknown error"}).\n`) })
		child.on("close", (code, childSignal) => {
			clearTimeout(killTimer)
			signal?.removeEventListener("abort", abort)
			if (spawnError) return resolve({ exitCode: spawnError === "ENOENT" ? 127 : spawnError === "EACCES" ? 126 : 1, signal: null, error: spawnError === "ENOENT" ? "command-not-found: The configured command was not found." : "command-start: The configured command could not start." })
			if (childSignal) return resolve(interrupted(childSignal))
			if (code === 0 && requestedSignal) return resolve(interrupted(requestedSignal))
			resolve({ exitCode: Number.isInteger(code) ? code : 1, signal: null, error: code === 0 ? null : classifyError(captured, env) })
		})
	})
}

export async function runMode(mode, { env = process.env, cwd = process.cwd(), signal, execute = executeCommand, transport = sendReport, metadata, stdout, stderr } = {}) {
	const stages = mode === "marker" || mode === "preinstall" ? [{ name: "preinstall" }] : STAGES[mode]
	if (!stages) throw new Error("Expected marker, preinstall, postinstall, or deploy mode.")
	const enabled = feedbackEnabled(env)
	const meta = metadata ?? (enabled ? runtimeMetadata(env, cwd) : null)
	const report = async (stage, event, result) => {
		if (enabled) { try { await transport(makeReport(stage, event, result, meta)) } catch { /* Reporting cannot change a command's result. */ } }
	}
	for (const stage of stages) {
		await report(stage.name, "start", {})
		const result = signal?.aborted ? interrupted(signal.reason) : stage.command ? await execute(stage, { env, cwd, signal, stdout, stderr }) : { exitCode: 0, signal: null, error: null }
		await report(stage.name, "finish", result)
		if (result.exitCode !== 0) return result
		if (signal?.aborted) return interrupted(signal.reason)
	}
	return { exitCode: 0, signal: null, error: null }
}

async function main() {
	const controller = new AbortController()
	const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map((name) => [name, () => controller.abort(name)]))
	for (const [name, handler] of handlers) process.on(name, handler)
	try {
		const result = await runMode(process.argv[2], { signal: controller.signal })
		process.exitCode = result.exitCode
	} catch {
		console.error("[build-feedback] Diagnostic wrapper failed before completing its configured stages.")
		process.exitCode = 1
	} finally {
		for (const [name, handler] of handlers) process.removeListener(name, handler)
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
