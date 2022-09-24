import { Command } from "commander"
import dotenv from "dotenv"
import type { Guild as DiscordClient } from "discord.js"
import { Spinner } from "../../libs/util/spinner.mjs"
import { createDiscordClient } from "../../libs/client.mjs"
import { MessageClient } from "../../libs/message.mjs"

dotenv.config({ path: "./.env" })
const spinner = new Spinner()

interface Options {
  discordBotToken: string
  discordServerId: string
}

;(async () => {
  const program = new Command()
  program
    .description("Deploy messsage command")
    .requiredOption(
      "-dt, --discord-bot-token [string]",
      "DiscordBot OAuth Token",
      process.env.DISCORD_BOT_TOKEN
    )
    .requiredOption(
      "-ds, --discord-server-id [string]",
      "Discord Server ID",
      process.env.DISCORD_SERVER_ID
    )
    .parse(process.argv)

  const { discordBotToken, discordServerId }: Options = program.opts()

  spinner.loading("Create client")
  let messageClient: MessageClient | undefined = undefined
  let discordClient: DiscordClient | undefined = undefined
  try {
    messageClient = new MessageClient()
    discordClient = await createDiscordClient(discordBotToken, discordServerId)
  } catch (error) {
    spinner.failed(null, error)
    process.exit(1)
  }
  spinner.success()

  spinner.loading("Deploy message")
  try {
    await messageClient.deployAllMessage(discordClient)
  } catch (error) {
    spinner.failed(null, error)
    process.exit(1)
  }
  spinner.success()

  process.exit(0)
})()
