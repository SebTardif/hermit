import { type ModalInteraction, serializePayload } from "@buape/carbon"
import { describe, expect, it, spyOn } from "bun:test"
import { formConfigs, formSettings } from "../forms.config.js"
import * as formActions from "../src/forms/actions.js"
import { formReviewModals } from "../src/forms/reviewButtons.js"
import * as formSubmissions from "../src/forms/submissions.js"

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

const payloadText = (payloads: unknown[]) =>
	payloads
		.flatMap((payload) => flattenComponents(serializePayload(payload)))
		.map((component) => component.content)
		.filter((content): content is string => typeof content === "string")
		.join("\n")

const pendingSubmission = {
	id: 42,
	formId: "discord-ban",
	status: "submitted",
	authProvider: "discord",
	applicantId: "applicant-1",
	applicantUsername: "Applicant",
	payload: JSON.stringify({
		action: "banned",
		punishment: "Ban",
		appealReason: "Please unban me"
	}),
	reviewChannelId: formSettings.reviewChannelId,
	reviewMessageId: "review-message-1",
	reviewThreadId: null,
	decidedAt: null,
	decidedById: null,
	decisionReason: null,
	actionResult: null,
	createdAt: "2026-09-01T00:00:00.000Z",
	updatedAt: "2026-09-01T00:00:00.000Z"
}

const runDecision = async (status: "accepted" | "denied") => {
	const replies: unknown[] = []
	const updates: unknown[] = []
	const dms: unknown[] = []
	const interaction = {
		user: { id: "reviewer-1" },
		member: { roles: [{ id: formSettings.reviewRoleId }] },
		fields: {
			getText: () => undefined
		},
		reply: async (payload: unknown) => {
			replies.push(payload)
		},
		update: async (payload: unknown) => {
			updates.push(payload)
		},
		client: {
			fetchUser: async () => ({
				send: async (payload: unknown) => {
					dms.push(payload)
				}
			})
		}
	} as unknown as ModalInteraction

	await formReviewModals[0].run(interaction, {
		id: pendingSubmission.id,
		status
	})

	return {
		replies,
		updates,
		dms,
		replyText: payloadText(replies),
		updateText: payloadText(updates)
	}
}

describe("form review action failure", () => {
	it("does not record accepted when form actions throw", async () => {
		process.env.DISCORD_CLIENT_ID = "test-client"
		process.env.DISCORD_CLIENT_SECRET = "test-secret"

		const form = formConfigs.find((item) => item.id === "discord-ban")
		expect(form).toBeDefined()

		const loadSpy = spyOn(formSubmissions, "getFormSubmission").mockImplementation(
			async () => pendingSubmission
		)
		const persistSpy = spyOn(formSubmissions, "recordFormDecision").mockImplementation(
			async () => {}
		)
		const actionSpy = spyOn(formActions, "runFormActions").mockImplementation(async () => {
			throw new Error("Discord 403: Missing Permissions")
		})

		try {
			const result = await runDecision("accepted")

			expect(actionSpy).toHaveBeenCalledTimes(1)
			expect(persistSpy).not.toHaveBeenCalled()
			expect(result.updates).toHaveLength(0)
			expect(result.dms).toHaveLength(0)
			expect(result.replies).toHaveLength(1)
			expect(result.replyText).toContain("Discord 403: Missing Permissions")
			expect(result.replyText.toLowerCase()).not.toContain("accepted")
			expect(result.updateText.toLowerCase()).not.toContain("accepted")
		} finally {
			loadSpy.mockRestore()
			persistSpy.mockRestore()
			actionSpy.mockRestore()
		}
	})

	it("does not record denied when form actions throw", async () => {
		process.env.DISCORD_CLIENT_ID = "test-client"
		process.env.DISCORD_CLIENT_SECRET = "test-secret"

		const loadSpy = spyOn(formSubmissions, "getFormSubmission").mockImplementation(
			async () => pendingSubmission
		)
		const persistSpy = spyOn(formSubmissions, "recordFormDecision").mockImplementation(
			async () => {}
		)
		const actionSpy = spyOn(formActions, "runFormActions").mockImplementation(async () => {
			throw new Error("Discord 403: Missing Permissions")
		})

		try {
			const result = await runDecision("denied")

			expect(actionSpy).toHaveBeenCalledTimes(1)
			expect(persistSpy).not.toHaveBeenCalled()
			expect(result.updates).toHaveLength(0)
			expect(result.dms).toHaveLength(0)
			expect(result.replies).toHaveLength(1)
			expect(result.replyText).toContain("Discord 403: Missing Permissions")
		} finally {
			loadSpy.mockRestore()
			persistSpy.mockRestore()
			actionSpy.mockRestore()
		}
	})

	it("records accepted after form actions succeed", async () => {
		process.env.DISCORD_CLIENT_ID = "test-client"
		process.env.DISCORD_CLIENT_SECRET = "test-secret"

		const loadSpy = spyOn(formSubmissions, "getFormSubmission").mockImplementation(
			async () => pendingSubmission
		)
		const persistSpy = spyOn(formSubmissions, "recordFormDecision").mockImplementation(
			async () => {}
		)
		const actionSpy = spyOn(formActions, "runFormActions").mockImplementation(
			async () => "discord.unban"
		)

		try {
			const result = await runDecision("accepted")

			expect(actionSpy).toHaveBeenCalledTimes(1)
			expect(persistSpy).toHaveBeenCalledTimes(1)
			expect(persistSpy.mock.calls[0]?.[0]).toBe(pendingSubmission.id)
			expect(persistSpy.mock.calls[0]?.[1]).toMatchObject({
				status: "accepted",
				decidedById: "reviewer-1",
				actionResult: "discord.unban"
			})
			expect(result.updates).toHaveLength(1)
			expect(result.dms).toHaveLength(1)
			expect(result.updateText.toLowerCase()).toContain("accepted")
		} finally {
			loadSpy.mockRestore()
			persistSpy.mockRestore()
			actionSpy.mockRestore()
		}
	})
})
