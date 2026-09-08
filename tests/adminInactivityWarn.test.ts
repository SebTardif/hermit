import { describe, expect, it } from "bun:test"
import {
	ChannelType,
	ComponentType,
	MessageFlags,
	serializePayload,
	type CommandInteraction,
	type MessagePayloadObject
} from "@buape/carbon"
import { InactivityWarn } from "../src/commands/admin.js"

const inactivityWarnChannel = "1477357508833185954"

const runWarn = async (options: {
	addMember?: (userId: string) => Promise<void>
	userId?: string
	actorId?: string
	username?: string
}) => {
	const userId = options.userId ?? "user-123"
	const actorId = options.actorId ?? "staff-456"
	const username = options.username ?? "warned-user"
	const addedMembers: string[] = []
	const sent: string[] = []
	const threadStarts: unknown[] = []
	const replies: MessagePayloadObject[] = []

	const thread = {
		addMember: options.addMember ?? (async (id: string) => {
			addedMembers.push(id)
		}),
		send: async (content: string) => {
			sent.push(content)
		}
	}

	const channel = {
		type: ChannelType.GuildText,
		startThread: async (payload: unknown) => {
			threadStarts.push(payload)
			return thread
		}
	}

	const interaction = {
		guild: { id: "guild-1" },
		user: { id: actorId },
		userId: actorId,
		options: {
			getUser: () => ({ id: userId, username }),
			getMentionable: () => null
		},
		client: {
			fetchChannel: async () => channel
		},
		reply: async (payload: MessagePayloadObject) => {
			replies.push(payload)
		}
	} as unknown as CommandInteraction

	await new InactivityWarn().run(interaction)

	return { replies, addedMembers, sent, threadStarts, userId, actorId }
}

describe("/admin inactivity-warn", () => {
	it("does not claim unqualified success when addMember is rejected", async () => {
		const { replies, sent, threadStarts, userId } = await runWarn({
			addMember: async () => {
				throw new Error("Missing Permissions")
			}
		})

		expect(threadStarts).toHaveLength(1)
		expect(sent).toHaveLength(1)
		expect(replies).toHaveLength(1)
		expect(replies[0]?.ephemeral).toBe(true)
		const payload = serializePayload(replies[0]!)
		expect(payload.content).toBeUndefined()
		expect(payload.flags).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2)
		expect(payload.components).toMatchObject([
			{
				type: ComponentType.Container,
				components: [
					{
						type: ComponentType.TextDisplay,
						content: `Created inactivity warning thread for <@${userId}> in <#${inactivityWarnChannel}>. Failed to add you to the thread.`
					}
				]
			}
		])
	})

	it("reports created thread after addMember resolves", async () => {
		const { replies, addedMembers, sent, userId, actorId } = await runWarn({})

		expect(addedMembers).toEqual([actorId])
		expect(sent).toHaveLength(1)
		expect(replies).toEqual([
			{
				content: `Created inactivity warning thread for <@${userId}> in <#${inactivityWarnChannel}>.`,
				ephemeral: true
			}
		])
	})
})
