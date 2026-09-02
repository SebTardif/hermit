type CommandDeploymentContext = {
	waitUntil(promise: Promise<unknown>): void
}

type DeployCommands = (options: {
	mode: "reconcile"
}) => Promise<unknown>

export const createCommandDeploymentTracker = (
	deployCommands: DeployCommands
) => {
	let deployment: Promise<unknown> | undefined

	return (context: CommandDeploymentContext) => {
		if (!deployment) {
			deployment = deployCommands({ mode: "reconcile" }).catch((error) => {
				deployment = undefined
				console.error("Failed to deploy Discord commands:", error)
				throw error
			})
		}

		context.waitUntil(deployment)
		return deployment
	}
}
