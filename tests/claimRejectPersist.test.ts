import {
	type Button,
	type ButtonInteraction,
	ComponentType,
	Container,
	MessageFlags,
	type Modal,
	type ModalInteraction,
	Row,
	Separator,
	TextDisplay,
	serializePayload
} from "@buape/carbon"
import { describe, expect, it, spyOn } from "bun:test"
import * as claimRequests from "../src/data/claimRequests.js"
import { claimReviewComponents, claimReviewModals } from "../src/server/claimServer.js"

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

const createReviewFlow = (failRestore = false) => {
	const replies: unknown[] = []
	const dms: unknown[] = []
	const patches: unknown[] = []
	const edits: ReturnType<typeof serializePayload>[] = []
	const modals: Modal[] = []
	const AcceptButton = claimReviewComponents[0].constructor as new (userId: string, guildId: string) => Button
	const RejectButton = claimReviewComponents[1].constructor as new (userId: string, guildId: string) => Button
	const initialComponents = [new Container([
		new TextDisplay("### Clawtributor Claim Request"),
		new TextDisplay("- User: <@user-1>\n- GitHub: [@applicant](<https://github.com/applicant>)"),
		new Separator({ divider: true, spacing: "large" }),
		new TextDisplay("### 3 Most Recent Merged PRs\n- [#1 A change](<https://github.com/example/project/pull/1>)"),
		new Separator({ divider: true, spacing: "small" }),
		new Row([new AcceptButton("user-1", "guild-1"), new RejectButton("user-1", "guild-1")])
	], { accentColor: "#f1c40f", spoiler: true }).serialize()]
	const message = {
		id: "review-message-1",
		channelId: "review-channel-1",
		rawData: { components: structuredClone(initialComponents) },
		edit: async (payload: Parameters<typeof serializePayload>[0]) => {
			const serialized = serializePayload(payload)
			edits.push(serialized)
			if (failRestore) throw new Error("Discord message update unavailable")
			message.rawData.components = structuredClone(serialized.components as typeof initialComponents)
		}
	}
	const interaction = {
		user: { id: "reviewer-1" },
		fields: { getText: () => "too few merged PRs" },
		message,
		reply: async (payload: unknown) => { replies.push(payload) },
		showModal: async (modal: Modal) => { modals.push(modal) },
		client: {
			fetchUser: async () => ({ send: async (payload: unknown) => { dms.push(payload) } }),
			rest: {
				patch: async (_route: string, payload: { body: { components: typeof initialComponents } }) => {
					patches.push(payload)
					message.rawData.components = structuredClone(payload.body.components)
				}
			}
		}
	}
	const data = { userId: "suser-1", guildId: "sguild-1" }
	return {
		replies, dms, patches, edits, modals, message, initialComponents,
		clickReject: () => claimReviewComponents[1].run(interaction as unknown as ButtonInteraction, data),
		submitReject: () => modals.at(-1)!.run(interaction as unknown as ModalInteraction, data),
		buttons: () => message.rawData.components
			.flatMap(flattenComponents)
			.filter(component => component.type === ComponentType.Button),
		cardText: () => message.rawData.components
			.flatMap(flattenComponents)
			.map(component => component.content)
			.filter(content => typeof content === "string")
			.join("\n")
	}
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

	it("restores the complete review card and permits a button-to-modal retry", async () => {
		const persistSpy = spyOn(claimRequests, "recordClaimDecision")
			.mockImplementationOnce(async () => { throw new Error("database unavailable") })
			.mockImplementation(async () => {})
		const consoleError = spyOn(console, "error").mockImplementation(() => {})
		try {
			const flow = createReviewFlow()
			await flow.clickReject()
			expect(flow.modals).toHaveLength(1)
			expect(flow.buttons().every(button => button.disabled)).toBe(true)
			expect(flow.cardText()).toContain("Rejection in progress")
			await flow.submitReject()

			expect(persistSpy).toHaveBeenCalledTimes(1)
			expect(flow.dms).toHaveLength(0)
			expect(flow.edits).toHaveLength(1)
			expect(flow.edits[0].allowed_mentions).toEqual({ parse: [] })
			expect(flow.edits[0].flags).toBe(MessageFlags.IsComponentsV2)
			expect(flow.message.rawData.components).toEqual(flow.initialComponents)
			expect(flow.buttons().every(button => !button.disabled)).toBe(true)
			expect(flow.cardText()).not.toContain("Rejection in progress")
			expect(replyText(flow.replies)).toContain("review buttons have been restored")

			await flow.clickReject()
			expect(flow.modals).toHaveLength(2)
			expect(flow.cardText().match(/Rejection in progress/g)).toHaveLength(1)
			await flow.submitReject()
			expect(persistSpy).toHaveBeenCalledTimes(2)
			expect(flow.dms).toHaveLength(1)
			expect(flow.buttons().every(button => button.disabled)).toBe(true)
			expect(flow.cardText()).toContain("Rejected by <@reviewer-1>")
			expect(replyText(flow.replies)).toContain("Claim rejected")
		} finally {
			consoleError.mockRestore()
			persistSpy.mockRestore()
		}
	})

	it("reports when Discord cannot restore the review after a failed save", async () => {
		const persistSpy = spyOn(claimRequests, "recordClaimDecision").mockImplementation(async () => {
			throw new Error("database unavailable")
		})
		const consoleError = spyOn(console, "error").mockImplementation(() => {})
		try {
			const flow = createReviewFlow(true)
			await flow.clickReject()
			await flow.submitReject()
			expect(flow.edits).toHaveLength(1)
			expect(flow.dms).toHaveLength(0)
			expect(flow.patches).toHaveLength(1)
			expect(flow.buttons().every(button => button.disabled)).toBe(true)
			expect(flow.cardText()).toContain("Rejection in progress")
			expect(replyText(flow.replies)).toContain("could not be reopened automatically")
			expect(replyText(flow.replies)).not.toContain("review buttons have been restored")
			expect(replyText(flow.replies)).not.toContain("Claim rejected")
		} finally {
			consoleError.mockRestore()
			persistSpy.mockRestore()
		}
	})

	it("preserves an unfamiliar review card instead of dropping its content", async () => {
		const persistSpy = spyOn(claimRequests, "recordClaimDecision").mockImplementation(async () => {
			throw new Error("database unavailable")
		})
		const consoleError = spyOn(console, "error").mockImplementation(() => {})
		try {
			const flow = createReviewFlow()
			await flow.clickReject()
			flow.message.rawData.components[0].components.push(new TextDisplay("Another review update").serialize())
			const before = structuredClone(flow.message.rawData.components)
			await flow.submitReject()
			expect(flow.edits).toHaveLength(0)
			expect(flow.dms).toHaveLength(0)
			expect(flow.message.rawData.components).toEqual(before)
			expect(replyText(flow.replies)).toContain("could not be reopened automatically")
		} finally {
			consoleError.mockRestore()
			persistSpy.mockRestore()
		}
	})
})
