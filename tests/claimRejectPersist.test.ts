import { type ModalInteraction, serializePayload } from "@buape/carbon"
import { describe, expect, it, spyOn } from "bun:test"
import * as claimRequests from "../src/data/claimRequests.js"
import { claimReviewModals } from "../src/server/claimServer.js"

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

const runReject = async () => {
	const replies: unknown[] = []
	const dms: unknown[] = []
	const patches: unknown[] = []
	const rejectModal = claimReviewModals[0]
	const interaction = {
		user: { id: "reviewer-1" },
		fields: {
			getText: () => "too few merged PRs"
		},
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
			rest: {
				patch: async (...args: unknown[]) => {
					patches.push(args)
				}
			}
		}
	} as unknown as ModalInteraction

	await rejectModal.run(interaction, {
		userId: "suser-1",
		guildId: "sguild-1"
	})

	return { replies, dms, patches, text: replyText(replies) }
}

describe("claim review reject persist", () => {
	it("does not report rejected when decision persist fails", async () => {
		const persistSpy = spyOn(
			claimRequests,
			"recordClaimDecision"
		).mockImplementation(async () => {
			throw new Error("database unavailable")
		})
		const consoleError = spyOn(console, "error").mockImplementation(() => {})

		try {
			const result = await runReject()

			expect(persistSpy).toHaveBeenCalledTimes(1)
			expect(result.replies).toHaveLength(1)
			expect(result.text.toLowerCase()).not.toContain("claim rejected")
			expect(result.text.toLowerCase()).not.toContain("rejection sent")
			expect(result.dms).toHaveLength(0)
			expect(result.patches).toHaveLength(0)
			expect(result.text).toContain("Could not record claim")
		} finally {
			consoleError.mockRestore()
			persistSpy.mockRestore()
		}
	})

	it("reports rejected after the decision is recorded", async () => {
		const persistSpy = spyOn(
			claimRequests,
			"recordClaimDecision"
		).mockImplementation(async () => {})
		const consoleError = spyOn(console, "error").mockImplementation(() => {})

		try {
			const result = await runReject()

			expect(persistSpy).toHaveBeenCalledTimes(1)
			expect(result.text.toLowerCase()).toContain("claim rejected")
			expect(result.dms).toHaveLength(1)
			expect(result.patches).toHaveLength(1)
		} finally {
			consoleError.mockRestore()
			persistSpy.mockRestore()
		}
	})
})
