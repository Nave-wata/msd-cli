import { access, readFile, readdir, mkdir, writeFile } from "node:fs/promises"
import { statSync, constants } from "node:fs"
import { dirname, join } from "node:path"
import { format, formatISO, fromUnixTime } from "date-fns"
import {
  Message as SlackBaseMessage,
  FileElement,
} from "@slack/web-api/dist/response/ChatPostMessageResponse"
import { ChannelType, EmbedType } from "discord.js"
import type { Guild as DiscordClientType, APIEmbed as Embed } from "discord.js"
import type { WebClient as SlackClientType } from "@slack/web-api"
import { getUser, getUsername } from "./user.mjs"
import type { User } from "./user.mjs"
import type { Channel } from "./channel.mjs"

export interface SlackMessage extends SlackBaseMessage {
  files?: FileElement[]
}

export interface Message {
  message_id?: string
  channel_id?: string
  guild_id?: string
  content?: string
  embeds?: Embed[]
  files?: string[]
  anthor?: {
    id: string
    name: string
    type: "bot"
  }
  timestamp?: number
  is_pinned: boolean
  slack: {
    anthor: {
      id: string
      name: string
      type: "bot" | "active-user" | "cancel-user"
      type_icon: "🟢" | "🔵" | "🤖"
      image_url: string
      color: string | "808080"
    }
    timestamp: string
  }
}

/**
 * Get message file
 * @param distMessageFilePath
 */
export const getMessageFile = async (
  distMessageFilePath: string
): Promise<{
  messages: Message[]
  status: "success" | "failed"
  message?: any
}> => {
  try {
    await access(distMessageFilePath, constants.R_OK)
    const messages = JSON.parse(
      await readFile(distMessageFilePath, "utf8")
    ) as Message[]
    return { messages: messages, status: "success" }
  } catch (error) {
    return { messages: [], status: "failed", message: error }
  }
}

/**
 * Create message file
 * @param distMessageFilePath
 * @param messages
 */
export const createMessageFile = async (
  distMessageFilePath: string,
  messages: Message[]
): Promise<{
  status: "success" | "failed"
  message?: any
}> => {
  try {
    await mkdir(dirname(distMessageFilePath), {
      recursive: true,
    })
    await writeFile(distMessageFilePath, JSON.stringify(messages, null, 2))
    return { status: "success" }
  } catch (error) {
    return { status: "failed", message: error }
  }
}

/**
 * Build message file
 * @param srcMessageFilePath
 * @param distMessageFilePath
 * @param users
 */
export const buildMessageFile = async (
  slackClient: SlackClientType,
  srcMessageFilePath: string,
  distMessageFilePath: string,
  users: User[],
  pinIds: string[],
  maxFileSize: number
): Promise<{
  messages: Message[]
  isMaxFileSizeOver?: boolean
  status: "success" | "failed"
  message?: any
}> => {
  const newMessages: Message[] = []
  try {
    await access(srcMessageFilePath, constants.R_OK)
    const messageFile = await readFile(srcMessageFilePath, "utf8")
    const messages = JSON.parse(messageFile) as SlackMessage[]
    let isMaxFileSizeOver = false
    for (const message of messages) {
      // メッセージの必須項目がない場合は例外を投げる
      if (message.text === undefined || message.ts === undefined) {
        throw new Error("Message is missing a required parameter")
      }

      let content = message.text

      // メッセージ内のユーザー名もしくはBot名のメンションを、Discordでメンションされない形式に置換
      const matchMention = content.match(/<@U[A-Z0-9]{10}>/g)
      if (matchMention?.length) {
        const userIds = matchMention.map((mention) =>
          mention.replace(/<@|>/g, "")
        )
        for (const userId of userIds) {
          const user = users.find((user) => user.slack.id === userId)
          if (user && user.slack.name) {
            content = content.replaceAll(`<@${userId}>`, `@${user.slack.name}`)
          } else {
            // usersにないメンションは、APIから取得する
            const getUsernameResult = await getUsername(slackClient, userId)
            const username = getUsernameResult.username
            if (username && getUsernameResult.status === "success") {
              content = content.replaceAll(`<@${userId}>`, `@${username}`)
            } else {
              throw new Error(
                `Failed to convert mention of @${userId} to username\n` +
                  getUsernameResult.message
              )
            }
          }
        }
      }

      // メッセージ内のチャンネルメンションタグを、Discordで表示される形式に置換
      if (/<!channel>/.test(content))
        content = content.replaceAll(/<!channel>/g, "@channel")

      // メッセージ内の太文字を、Discordで表示される形式に置換
      if (/\*.*\*/.test(content)) content = content.replaceAll(/\**\*/g, "**")

      // メッセージ内の斜体文字を、Discordで表示される形式に置換
      // if (/\_.*\_/.test(content)) content = content.replaceAll(/\_*\_/g, "_")

      // メッセージ内の打ち消し線を、Discordで表示される形式に置換
      if (/~.*~/.test(content)) content = content.replaceAll(/~*~/g, "~~")

      // メッセージ内の引用タグを、Discordで表示される形式に置換
      if (/&gt; .*/.test(content)) content = content.replaceAll(/&gt; /g, "> ")

      // メッセージ内のURLタグを、Discordで表示される形式に置換
      if (/<http|https:\/\/.*\|.*>/.test(content))
        content = content.replaceAll(/<|\|.*>/g, "")

      // 埋め込みフィールドを作成
      const fields: Embed["fields"] = [
        {
          name: "------------------------------------------------",
          value: content,
        },
      ]

      // メッセージの送信者情報を取得
      let user = users.find(
        (user) =>
          user.slack.id === message.user ||
          user.slack.bot?.app_id === message.app_id
      )
      // メッセージの送信者情報が取得できない場合は、APIから取得
      if (!user) {
        if (message.user) {
          const getUserResult = await getUser(slackClient, message.user)
          if (getUserResult.user) {
            user = getUserResult.user
          }
        }
        if (!user) {
          throw new Error("Failed to get user for message")
        }
      }
      const anthor: Message["slack"]["anthor"] = {
        id: user.slack.id,
        name: user.slack.name,
        type: message.bot_id
          ? "bot"
          : user.slack.deleted
          ? "cancel-user"
          : "active-user",
        color: user.slack.color,
        type_icon: message.bot_id ? "🤖" : user.slack.deleted ? "🔵" : "🟢",
        image_url: user.slack.image_url,
      }

      // メッセージの投稿日時を算出
      const postTime = format(fromUnixTime(Number(message.ts)), " HH:mm")
      const isoPostDatetime = formatISO(fromUnixTime(Number(message.ts)))

      // メッセージがピン留めアイテムか判別
      const isPinned = pinIds.includes(message.ts) ? true : false

      newMessages.push({
        content: content,
        embeds: [
          {
            type: EmbedType.Rich,
            color: parseInt(anthor.color, 16),
            fields: fields,
            timestamp: isoPostDatetime,
            author: {
              name: `${anthor.type_icon} ${anthor.name}    ${postTime}`,
              icon_url: anthor.image_url,
            },
          },
        ],
        is_pinned: isPinned,
        slack: {
          anthor: anthor,
          timestamp: message.ts,
        },
      })

      // Discordにアップロードできる最大ファイルサイズを超過したファイルは、ファイルをアップロードせず、ファイルURLを添付する
      const sizeOverFileUrls = message.files
        ?.filter((file) => file.size && file.size >= maxFileSize)
        .map((file) => file.url_private || "")
      const uploadFileUrls = message.files
        ?.filter((file) => file.size && file.size < maxFileSize)
        .map((file) => file.url_private || "")
      if (sizeOverFileUrls || uploadFileUrls) {
        // 埋め込みの下に添付ファイルが表示されるように、添付ファイルは別メッセージにする
        newMessages.push({
          content: sizeOverFileUrls ? sizeOverFileUrls?.join("\n") : "",
          files: uploadFileUrls?.length ? uploadFileUrls : undefined,
          is_pinned: isPinned,
          slack: {
            anthor: anthor,
            timestamp: message.ts,
          },
        })
      }
    }

    // メッセージファイルを作成
    const createMessageFileResult = await createMessageFile(
      distMessageFilePath,
      newMessages
    )
    if (createMessageFileResult.status === "failed") {
      return {
        messages: [],
        status: "failed",
        message: createMessageFileResult.message,
      }
    }

    return {
      messages: newMessages,
      isMaxFileSizeOver: isMaxFileSizeOver,
      status: "success",
    }
  } catch (error) {
    return { messages: [], status: "failed", message: error }
  }
}

/**
 * Build all message file
 * @param channels
 * @param users
 */
export const buildAllMessageFile = async (
  slackClient: SlackClientType,
  channels: Channel[],
  users: User[]
): Promise<{
  isMaxFileSizeOver?: boolean
  status: "success" | "failed"
  message?: any
}> => {
  try {
    let isMaxFileSizeOver = false
    await Promise.all(
      channels.map(
        async (channel) =>
          await Promise.all(
            channel.slack.message_file_paths.map(
              async (srcMessageFilePath, index) => {
                const distMessageFilePath =
                  channel.discord.message_file_paths[index]
                const buildMessageFileResult = await buildMessageFile(
                  slackClient,
                  srcMessageFilePath,
                  distMessageFilePath,
                  users,
                  channel.slack.pin_ids,
                  channel.discord.guild.max_file_size
                )
                if (
                  buildMessageFileResult.isMaxFileSizeOver &&
                  !isMaxFileSizeOver
                ) {
                  isMaxFileSizeOver = true
                }
                if (buildMessageFileResult.status === "failed") {
                  throw new Error(buildMessageFileResult.message)
                }
              }
            )
          )
      )
    )
    return { isMaxFileSizeOver: isMaxFileSizeOver, status: "success" }
  } catch (error) {
    return { status: "failed", message: error }
  }
}

/**
 * Get message directory path
 * @param messageDirPath
 */
export const getMessageFilePaths = async (messageDirPath: string) => {
  const fileOrDirNames = await readdir(join(messageDirPath))
  const messageFilePaths = fileOrDirNames
    .filter(
      (fileOrDirName) =>
        // TODO: 非同期関数に置換する
        statSync(join(messageDirPath, fileOrDirName)).isFile() &&
        new RegExp(
          /[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]).json/g
        ).test(fileOrDirName)
    )
    .map((fileOrDirName) => join(messageDirPath, fileOrDirName))
  return messageFilePaths
}

/**
 * Deploy message
 * @param discordClient
 * @param channelId
 * @param distMessageFilePath
 * @param messages
 */
export const deployMessage = async (
  discordClient: DiscordClientType,
  messages: Message[],
  channelId: string,
  distMessageFilePath: string
): Promise<{
  messages: Message[]
  isMaxFileSizeOver?: boolean
  status: "success" | "failed"
  message?: any
}> => {
  try {
    // メッセージを作成
    const channelGuild = discordClient.channels.cache.get(channelId)
    const newMessages: Message[] = []
    let isMaxFileSizeOver = false
    if (channelGuild && channelGuild.type === ChannelType.GuildText) {
      for (const message of messages) {
        const sendMessage = await channelGuild.send({
          content: message.embeds ? undefined : message.content,
          files: message.files,
          embeds: message.embeds,
        })

        // メッセージの送信結果が取得できない場合は、例外を投げる
        if (!sendMessage || !sendMessage.guildId) {
          throw new Error("Failed to get deploy message result")
        }

        // ピン留めアイテムの場合は、ピン留めする
        if (message.is_pinned) {
          const pinMessage = await sendMessage.pin()
          if (!pinMessage || !pinMessage.guildId) {
            throw new Error("Failed to pin message")
          }
          // ピン留めアイテムの追加メッセージを追加
          newMessages.push({
            ...message,
            ...{
              message_id: pinMessage.id,
              channel_id: pinMessage.channelId,
              guild_id: pinMessage.guildId,
              timestamp: pinMessage.createdTimestamp,
              anthor: {
                id: pinMessage.author.id,
                name: pinMessage.author.username,
                type: "bot",
              },
            },
          })
        }

        newMessages.push({
          ...message,
          ...{
            message_id: sendMessage.id,
            channel_id: sendMessage.channelId,
            guild_id: sendMessage.guildId,
            timestamp: sendMessage.createdTimestamp,
            anthor: {
              id: sendMessage.author.id,
              name: sendMessage.author.username,
              type: "bot",
            },
          },
        })
      }
    }

    // メッセージファイルを更新
    const createMessageFileResult = await createMessageFile(
      distMessageFilePath,
      newMessages
    )
    if (createMessageFileResult.status === "failed") {
      return {
        messages: [],
        status: "failed",
        message: createMessageFileResult.message,
      }
    }

    return {
      messages: newMessages,
      isMaxFileSizeOver: isMaxFileSizeOver,
      status: "success",
    }
  } catch (error) {
    return { messages: [], status: "failed", message: error }
  }
}

/**
 * Deploy all message
 */
export const deployAllMessage = async (
  discordClient: DiscordClientType,
  channels: Channel[]
): Promise<{
  isMaxFileSizeOver?: boolean
  status: "success" | "failed"
  message?: any
}> => {
  try {
    let isMaxFileSizeOver = false
    await Promise.all(
      channels.map(async (channel) => {
        for (const messageFilePath of channel.discord.message_file_paths) {
          const getMessageFileResult = await getMessageFile(messageFilePath)
          if (getMessageFileResult.status === "failed") {
            throw new Error(getMessageFileResult.message)
          }
          const deployMessageResult = await deployMessage(
            discordClient,
            getMessageFileResult.messages,
            channel.discord.channel_id,
            messageFilePath
          )
          if (deployMessageResult.status === "failed") {
            throw new Error(deployMessageResult.message)
          }
          if (deployMessageResult.isMaxFileSizeOver && !isMaxFileSizeOver) {
            isMaxFileSizeOver = true
          }
        }
      })
    )
    return { isMaxFileSizeOver: isMaxFileSizeOver, status: "success" }
  } catch (error) {
    return { status: "failed", message: error }
  }
}

/**
 *  Delete message
 * @param discordClient
 * @param channelId
 * @param messages
 */
export const deleteMessage = async (
  discordClient: DiscordClientType,
  messages: Message[],
  channelId: string
): Promise<{
  status: "success" | "failed"
  message?: any
}> => {
  try {
    // メッセージを削除
    const channelGuild = discordClient.channels.cache.get(channelId)
    if (channelGuild && channelGuild.type === ChannelType.GuildText) {
      for (const message of messages) {
        if (message.message_id) {
          // ピン留めアイテムの場合は、ピン留めを解除する
          if (message.is_pinned) {
            await channelGuild.messages.unpin(message.message_id)
          }
          await channelGuild.messages.delete(message.message_id)
        }
      }
    }

    return {
      status: "success",
    }
  } catch (error) {
    return {
      status: "failed",
      message: error,
    }
  }
}

/**
 * Delete all message
 */
export const deleteAllMessage = async (
  discordClient: DiscordClientType,
  channels: Channel[]
): Promise<{
  status: "success" | "failed"
  message?: any
}> => {
  try {
    await Promise.all(
      channels.map(async (channel) => {
        await Promise.all(
          channel.discord.message_file_paths.map(async (messageFilePath) => {
            const getMessageFileResult = await getMessageFile(messageFilePath)
            if (getMessageFileResult.status === "failed") {
              throw new Error(getMessageFileResult.message)
            }
            const deleteMessageResult = await deleteMessage(
              discordClient,
              getMessageFileResult.messages,
              channel.discord.channel_id
            )
            if (deleteMessageResult.status === "failed") {
              throw new Error(deleteMessageResult.message)
            }
          })
        )
      })
    )
    return { status: "success" }
  } catch (error) {
    return { status: "failed", message: error }
  }
}
