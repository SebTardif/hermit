import { type ButtonInteraction, serializePayload } from "@buape/carbon"
import { describe, expect, it, spyOn } from "bun:test"
import * as claimRequests from "../src/data/claimRequests.js"
import { setRuntimeEnv } from "../src/runtime/env.js"
import { claimReviewComponents } from "../src/server/claimServer.js"

const flattenComponents = (component: unknown): Record<string, unknown>[] => {
	if (!component || typeof component !== "object") {
		return []
	}

	const record = component as Record<string, unknown>
	const children = Array.isArray(record.components)
		? record.components.flatMap(flattenComponents)
		: []

	return [record, ...children]
}

const replyText = (replies: unknown[]) =>
	replies
		.flatMap((reply) => flattenComponents(serializePayload(reply)))
		.map((component) => component.content)
		.filter((content): content is string => typeof content === "string")
		.join("\n")

const runAccept = async () => {
	const replies: unknown[] = []
	const dms: unknown[] = []
	const announcements: unknown[] = []
	const patches: unknown[] = []
	const acceptButton = claimReviewComponents[0]
	const interaction = {
		user: { id: "reviewer-1" },
		message: {
			id: "review-message-1",
			channelId: "review-channel-1",
			rawData: { components: [] }
		},
		reply: async (payload: unknown) => {
			replies.push(payload)
		},
		client: {
			fetchUser: async () => ({
				send: async (payload: unknown) => {
					dms.push(payload)
				}
			}),
			fetchChannel: async () => ({
				send: async (payload: unknown) => {
					announcements.push(payload)
				}
			}),
			rest: {
				patch: async (...args: unknown[]) => {
					patches.push(args)
				}
			}
		}
	} as unknown as ButtonInteraction

	await acceptButton.run(interaction, {
		userId: "suser-1",
		guildId: "sguild-1"
	})

	return { replies, dms, announcements, patches, text: replyText(replies) }
}

describe("claim review accept persist", () => {
	it("does not report accepted when decision persist fails", async () => {
		setRuntimeEnv({ DISCORD_BOT_TOKEN: "test-token" } as Env)
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(null, { status: 204 })
		)
		const persistSpy = spyOn(
			claimRequests,
			"recordClaimDecision"
		).mockImplementation(async () => {
			throw new Error("database unavailable")
		})
		const consoleError = spyOn(console, "error").mockImplementation(() => {})

		try {
			const result = await runAccept()

			expect(persistSpy).toHaveBeenCalledTimes(1)
			expect(result.replies).toHaveLength(1)
			expect(result.text.toLowerCase()).not.toContain("claim accepted")
			expect(result.text.toLowerCase()).not.toContain("has been given the role")
			expect(result.dms).toHaveLength(0)
			expect(result.announcements).toHaveLength(0)
			expect(result.patches).toHaveLength(0)
			expect(result.text).toContain("Could not record claim")
		} finally {
			consoleError.mockRestore()
			persistSpy.mockRestore()
			fetchSpy.mockRestore()
		}
	})

	it("reports accepted after the decision is recorded", async () => {
		setRuntimeEnv({ DISCORD_BOT_TOKEN: "test-token" } as Env)
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(null, { status: 204 })
		)
		const persistSpy = spyOn(
			claimRequests,
			"recordClaimDecision"
		).mockImplementation(async () => {})
		const consoleError = spyOn(console, "error").mockImplementation(() => {})

		try {
			const result = await runAccept()

			expect(persistSpy).toHaveBeenCalledTimes(1)
			expect(result.text.toLowerCase()).toContain("claim accepted")
			expect(result.dms).toHaveLength(1)
			expect(result.announcements).toHaveLength(1)
		} finally {
			consoleError.mockRestore()
			persistSpy.mockRestore()
			fetchSpy.mockRestore()
		}
	})
})
