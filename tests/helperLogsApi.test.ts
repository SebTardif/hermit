import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import type { Client } from "@buape/carbon"
import { registerHelperLogsRoutes } from "../src/server/helperLogsServer.js"
import { setRuntimeEnv } from "../src/runtime/env.js"
import { SqliteD1Database } from "./helpers/sqliteD1.js"

const applyMigration = (database: Database, path: string) => {
	const migration = readFileSync(path, "utf8")
	for (const statement of migration.split("--> statement-breakpoint")) {
		const trimmed = statement.trim()
		if (trimmed.length > 0) {
			database.run(trimmed)
		}
	}
}

const seedHelperLogs = (owner: SqliteD1Database) => {
	owner.database.run(
		"insert into helper_events (event_type, thread_id, message_count, event_time, command, invoked_by_id, invoked_by_username, invoked_by_global_name, raw_payload) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			"helper_command",
			"111",
			2,
			"2026-09-02T00:00:00.000Z",
			"/helper close-thread",
			"222",
			"helper-user",
			"Helper User",
			"{}"
		]
	)
	owner.database.run(
		"insert into tracked_threads (thread_id, created_at, last_checked, solved, warning_level, closed, last_message_count, raw_payload) values (?, ?, ?, ?, ?, ?, ?, ?)",
		[
			"111",
			"2026-09-02T00:00:00.000Z",
			"2026-09-02T00:01:00.000Z",
			0,
			0,
			0,
			2,
			"{}"
		]
	)
}

const routesFor = (secret = "deploy-secret") => {
	const owner = new SqliteD1Database()
	applyMigration(owner.database, "drizzle/0000_productive_tinkerer.sql")
	seedHelperLogs(owner)
	setRuntimeEnv({
		DB: owner as unknown as D1Database,
		DEPLOY_SECRET: secret
	} as Env)

	const client = { routes: [] as Array<{
		method: string
		path: string
		handler: (request: Request) => Response | Promise<Response>
	}> }
	registerHelperLogsRoutes(client as unknown as Client)
	return client
}

const route = (
	client: ReturnType<typeof routesFor>,
	path: string
) => {
	const found = client.routes.find((entry) => entry.method === "GET" && entry.path === path)
	if (!found) {
		throw new Error(`Missing GET ${path}`)
	}
	return found
}

describe("helper logs HTTP API", () => {
	it("rejects unauthenticated GET /api/events", async () => {
		const client = routesFor()
		const response = await route(client, "/api/events").handler(
			new Request("https://hermit-discord.openclaw.ai/api/events")
		)

		expect(response.status).toBe(401)
		expect(await response.json()).toEqual({ error: "Unauthorized" })
	})

	it("rejects unauthenticated GET /api/threads", async () => {
		const client = routesFor()
		const response = await route(client, "/api/threads").handler(
			new Request("https://hermit-discord.openclaw.ai/api/threads")
		)

		expect(response.status).toBe(401)
		expect(await response.json()).toEqual({ error: "Unauthorized" })
	})

	it("rejects authorization headers without the Bearer scheme", async () => {
		const client = routesFor()
		const response = await route(client, "/api/events").handler(
			new Request("https://hermit-discord.openclaw.ai/api/events", {
				headers: { Authorization: "deploy-secret" }
			})
		)

		expect(response.status).toBe(401)
	})

	it("rejects the wrong bearer token", async () => {
		const client = routesFor()
		const response = await route(client, "/api/threads").handler(
			new Request("https://hermit-discord.openclaw.ai/api/threads", {
				headers: { Authorization: "Bearer wrong-secret" }
			})
		)

		expect(response.status).toBe(401)
	})

	it("returns helper events when the deploy secret is presented", async () => {
		const client = routesFor()
		const response = await route(client, "/api/events").handler(
			new Request("https://hermit-discord.openclaw.ai/api/events?limit=10", {
				headers: { Authorization: "Bearer deploy-secret" }
			})
		)
		const body = await response.json() as { count: number; events: Array<{ command: string }> }

		expect(response.status).toBe(200)
		expect(body.count).toBe(1)
		expect(body.events[0]?.command).toBe("/helper close-thread")
	})

	it("returns tracked threads when the deploy secret is presented", async () => {
		const client = routesFor()
		const response = await route(client, "/api/threads").handler(
			new Request("https://hermit-discord.openclaw.ai/api/threads?limit=10", {
				headers: { Authorization: "Bearer deploy-secret" }
			})
		)
		const body = await response.json() as { count: number; threads: Array<{ thread_id: string }> }

		expect(response.status).toBe(200)
		expect(body.count).toBe(1)
		expect(body.threads[0]?.thread_id).toBe("111")
	})

	it("keeps the HTML index public", async () => {
		const client = routesFor()
		const response = await route(client, "/").handler(
			new Request("https://hermit-discord.openclaw.ai/")
		)

		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toContain("text/html")
	})

	it("rejects JSON reads when DEPLOY_SECRET is unset", async () => {
		const client = routesFor("")
		const response = await route(client, "/api/events").handler(
			new Request("https://hermit-discord.openclaw.ai/api/events", {
				headers: { Authorization: "Bearer deploy-secret" }
			})
		)

		expect(response.status).toBe(401)
	})
})
