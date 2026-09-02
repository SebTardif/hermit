import type { Client } from "@buape/carbon"
import { listEvents, listTrackedThreads } from "../data/helperLogs.js"
import { getRuntimeEnv } from "../runtime/env.js"

const asStringOrNull = (value: unknown): string | null =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : null

const parseLimit = (rawValue: string | null, fallback = 100) => {
	const parsed = Number.parseInt(rawValue ?? "", 10)
	if (!Number.isFinite(parsed)) {
		return fallback
	}

	return Math.min(Math.max(Math.trunc(parsed), 1), 500)
}

const json = (data: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(data), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...init?.headers
		}
	})

const bearerToken = (request: Request) =>
	request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? ""

const requireDeploySecret = (request: Request) => {
	const token = getRuntimeEnv().DEPLOY_SECRET
	if (!token || bearerToken(request) !== token) {
		return json({ error: "Unauthorized" }, { status: 401 })
	}

	return null
}

const renderHtml = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Hermit helper logs</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; }
      a { color: #2563eb; text-decoration: none; }
      a:hover { text-decoration: underline; }
      code { background: #f3f4f6; padding: 0.15rem 0.35rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Hermit helper logs</h1>
    <p>JSON endpoints:</p>
    <ul>
      <li><a href="/api/events">/api/events</a></li>
      <li><a href="/api/threads">/api/threads</a></li>
    </ul>
    <p>Filters: <code>eventType</code>, <code>command</code>, <code>threadId</code>, <code>invokedBy</code>, <code>from</code>, <code>to</code>, <code>limit</code>.</p>
  </body>
</html>`

export const registerHelperLogsRoutes = (client: Client) => {
	client.routes.push(
		{
			method: "GET",
			path: "/",
			handler: () =>
				new Response(renderHtml(), {
					headers: {
						"content-type": "text/html; charset=utf-8"
					}
				})
		},
		{
			method: "GET",
			path: "/api/events",
			handler: async (request) => {
				const denied = requireDeploySecret(request)
				if (denied) {
					return denied
				}

				const url = new URL(request.url)
				const events = await listEvents({
					eventType: asStringOrNull(url.searchParams.get("eventType")),
					command: asStringOrNull(url.searchParams.get("command")),
					threadId: asStringOrNull(url.searchParams.get("threadId")),
					invokedBy: asStringOrNull(url.searchParams.get("invokedBy")),
					from: asStringOrNull(url.searchParams.get("from")),
					to: asStringOrNull(url.searchParams.get("to")),
					limit: parseLimit(url.searchParams.get("limit"))
				})

				return json({ count: events.length, events })
			}
		},
		{
			method: "GET",
			path: "/api/threads",
			handler: async (request) => {
				const denied = requireDeploySecret(request)
				if (denied) {
					return denied
				}

				const url = new URL(request.url)
				const threads = await listTrackedThreads({
					threadId: asStringOrNull(url.searchParams.get("threadId")),
					solved:
						url.searchParams.get("solved") === null
							? undefined
							: url.searchParams.get("solved") === "1" ||
								url.searchParams.get("solved")?.toLowerCase() === "true",
					closed:
						url.searchParams.get("closed") === null
							? undefined
							: url.searchParams.get("closed") === "1" ||
								url.searchParams.get("closed")?.toLowerCase() === "true",
					limit: parseLimit(url.searchParams.get("limit"))
				})

				return json({ count: threads.length, threads })
			}
		}
	)
}
