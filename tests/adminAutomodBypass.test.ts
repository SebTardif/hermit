import { describe, expect, it } from "bun:test"
import {
	ApplicationCommandOptionType,
	ApplicationCommandType,
	ApplicationIntegrationType,
	Client,
	ComponentType,
	InteractionContextType,
	InteractionResponseType,
	InteractionType,
	MessageFlags
} from "@buape/carbon"
import AdminCommand from "../src/commands/admin.js"

const automodBypassRoleId = "1469051644024193126"
const userId = "member-test"

type RestCall = {
	method: string
	path: string
	body?: Record<string, unknown>
}

const startToggle = (hasRole: boolean, roleChange: () => Promise<void>) => {
	const calls: RestCall[] = []
	const client = new Client({
		baseUrl: "https://example.invalid",
		clientId: "app-test",
		publicKey: "test-only",
		token: "test-only",
		disableDeployRoute: true,
		autoDeploy: false
	}, { commands: [new AdminCommand()] })
	// Exercise Carbon's handler, member methods, and serializer without network calls.
	client.rest = {
		post: async (path: string, options: { body: Record<string, unknown> }) => {
			calls.push({ method: "POST", path, body: options.body })
			return {}
		},
		patch: async (path: string, options: { body: Record<string, unknown> }) => {
			calls.push({ method: "PATCH", path, body: options.body })
			return { id: "reply-test", channel_id: "channel-test" }
		},
		put: async (path: string) => {
			calls.push({ method: "PUT", path })
			await roleChange()
		},
		delete: async (path: string) => {
			calls.push({ method: "DELETE", path })
			await roleChange()
		}
	} as unknown as Client["rest"]
	const running = client.commandHandler.handleCommandInteraction({
		id: "interaction-test",
		token: "test-only",
		type: InteractionType.ApplicationCommand,
		guild_id: "guild-test",
		member: { user: { id: "staff-test", username: "staff" } },
		data: {
			name: "admin",
			type: ApplicationCommandType.ChatInput,
			options: [{
				name: "automod-bypass-toggle",
				type: ApplicationCommandOptionType.Subcommand,
				options: [{ name: "user", type: ApplicationCommandOptionType.User, value: userId }]
			}],
			resolved: {
				users: { [userId]: { id: userId, username: "member" } },
				members: { [userId]: { roles: hasRole ? [automodBypassRoleId] : [] } }
			}
		}
	} as Parameters<Client["commandHandler"]["handleCommandInteraction"]>[0])
	return { calls, running }
}

const expectPrivateDefer = (calls: RestCall[]) => {
	expect(calls[0]).toMatchObject({
		method: "POST",
		body: {
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral }
		}
	})
}

describe("/admin automod-bypass-toggle", () => {
	it("keeps the parent admin command guild-only", () => {
		const command = new AdminCommand().serialize()
		expect(command.integration_types).toEqual([ApplicationIntegrationType.GuildInstall])
		expect(command.contexts).toEqual([InteractionContextType.Guild])
	})

	for (const hasRole of [false, true]) {
		const verb = hasRole ? "remove" : "add"
		const method = hasRole ? "DELETE" : "PUT"

		it(`reports ${verb}Role rejection privately with Carbon components`, async () => {
			const { calls, running } = startToggle(hasRole, async () => {
				throw new Error("Missing Permissions")
			})
			await running

			expectPrivateDefer(calls)
			expect(calls.map(call => call.method)).toEqual(["POST", method, "PATCH"])
			expect(calls[1]?.path).toBe(`/guilds/guild-test/members/${userId}/roles/${automodBypassRoleId}`)
			expect(calls[2]?.body).toMatchObject({
				flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
				components: [{
					type: ComponentType.Container,
					components: [{ type: ComponentType.TextDisplay, content: `Failed to ${verb} automod bypass role.` }]
				}]
			})
			expect(calls[2]?.body?.content).toBeUndefined()
		})

		it(`reports success only after ${verb}Role resolves`, async () => {
			let resolveRole!: () => void
			let markRoleStarted!: () => void
			const roleStarted = new Promise<void>(resolve => { markRoleStarted = resolve })
			const roleChange = new Promise<void>(resolve => { resolveRole = resolve })
			const { calls, running } = startToggle(hasRole, async () => {
				markRoleStarted()
				await roleChange
			})
			await roleStarted

			expectPrivateDefer(calls)
			expect(calls.map(call => call.method)).toEqual(["POST", method])
			resolveRole()
			await running
			expect(calls.map(call => call.method)).toEqual(["POST", method, "PATCH"])
			expect(calls[2]?.body).toMatchObject({
				content: hasRole
					? `Removed automod bypass role from <@${userId}>.`
					: `Added automod bypass role to <@${userId}>.`,
				flags: MessageFlags.Ephemeral
			})
		})
	}
})
