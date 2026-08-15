import { describe, expect, it } from "bun:test"
import { type CommandInteraction } from "@buape/carbon"
import { AutomodBypassToggle } from "../src/commands/admin.js"

const automodBypassRoleId = "1469051644024193126"

const runToggle = async (options: {
	roleIds?: string[]
	addRole?: (roleId: string, reason?: string) => Promise<void>
	removeRole?: (roleId: string, reason?: string) => Promise<void>
	userId?: string
}) => {
	const userId = options.userId ?? "user-123"
	const added: Array<[string, string | undefined]> = []
	const removed: Array<[string, string | undefined]> = []
	const replies: Array<{ content?: string; ephemeral?: boolean }> = []
	const member = {
		roles: (options.roleIds ?? []).map((id) => ({ id })),
		user: { id: userId },
		addRole: options.addRole ?? (async (roleId: string, reason?: string) => {
			added.push([roleId, reason])
		}),
		removeRole: options.removeRole ?? (async (roleId: string, reason?: string) => {
			removed.push([roleId, reason])
		})
	}
	const interaction = {
		guild: { id: "guild-1" },
		options: {
			getMember: () => member
		},
		reply: async (payload: { content?: string; ephemeral?: boolean }) => {
			replies.push(payload)
		}
	} as unknown as CommandInteraction

	await new AutomodBypassToggle().run(interaction)

	return { replies, added, removed, userId }
}

const replyContent = (replies: Array<{ content?: string }>) =>
	replies.map((reply) => reply.content ?? "").join("\n")

describe("/admin automod-bypass-toggle", () => {
	it("does not claim success when addRole is rejected", async () => {
		const { replies, userId } = await runToggle({
			roleIds: [],
			addRole: async () => {
				throw new Error("Missing Permissions")
			}
		})

		expect(replies).toHaveLength(1)
		expect(replies[0]?.ephemeral).toBe(true)
		expect(replyContent(replies)).not.toContain(
			`Added automod bypass role to <@${userId}>.`
		)
		expect(replyContent(replies).toLowerCase()).toContain("failed")
	})

	it("does not claim success when removeRole is rejected", async () => {
		const { replies, userId } = await runToggle({
			roleIds: [automodBypassRoleId],
			removeRole: async () => {
				throw new Error("Missing Permissions")
			}
		})

		expect(replies).toHaveLength(1)
		expect(replies[0]?.ephemeral).toBe(true)
		expect(replyContent(replies)).not.toContain(
			`Removed automod bypass role from <@${userId}>.`
		)
		expect(replyContent(replies).toLowerCase()).toContain("failed")
	})

	it("reports success only after addRole resolves", async () => {
		const { replies, added, userId } = await runToggle({
			roleIds: []
		})

		expect(added).toEqual([
			[automodBypassRoleId, "Added automod bypass role"]
		])
		expect(replies).toEqual([
			{
				content: `Added automod bypass role to <@${userId}>.`,
				ephemeral: true
			}
		])
	})

	it("reports success only after removeRole resolves", async () => {
		const { replies, removed, userId } = await runToggle({
			roleIds: [automodBypassRoleId]
		})

		expect(removed).toEqual([
			[automodBypassRoleId, "Removed automod bypass role"]
		])
		expect(replies).toEqual([
			{
				content: `Removed automod bypass role from <@${userId}>.`,
				ephemeral: true
			}
		])
	})
})
