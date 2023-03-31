import { PrismaClient, Message, User } from '@prisma/client'
import { access, readFile, constants, readdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as urlParse } from 'node:url'
import { format, formatISO, fromUnixTime } from 'date-fns'
import { WebClient as SlackClient } from '@slack/web-api'
import { FileElement } from '@slack/web-api/dist/response/ChatPostMessageResponse'
import { ChannelType, EmbedType } from 'discord.js'
import type {
  Guild as DiscordClient,
  TextChannel,
  APIEmbed as Embed,
  Message as MessageManager,
} from 'discord.js'
import { ChannelClient } from './channel.mjs'
import { UserClient } from './user.mjs'
import { getDiscordServerMaxFileSize } from './server.mjs'

interface SlackMessageFile {
  type?: 'message'
  subtype?: string | 'bot_message'
  text?: string
  ts?: string
  user?: string
  bot_id?: string
  app_id?: string
  files?: FileElement[]
  thread_ts?: string
  replies?: {
    user: string
    ts: string
  }[]
}

interface File {
  name: string
  url: string
  size: number
  mimetype: string
}

interface Url {
  name: string
  url: string
}

export class MessageClient {
  client: PrismaClient
  channelClient: ChannelClient
  userClient: UserClient
  constructor(client = new PrismaClient()) {
    this.client = client
    this.channelClient = new ChannelClient(this.client)
    this.userClient = new UserClient(this.client)
  }

  /**
   * Migrate all message data
   * @param discordClient
   * @param slackClient
   * @param srcDirpath
   */
  async migrateAllMessage(
    discordClient: DiscordClient,
    slackClient: SlackClient,
    srcDirpath: string
  ) {
    const channels = await this.channelClient.getAllChannel()
    const maxFileSize = getDiscordServerMaxFileSize(discordClient)

    for (const channel of channels) {
      if (!channel.deployId) throw new Error(`Failed to deployed channel id of ${channel.id}`)

      const messageDirPath = join(srcDirpath, channel.name)
      const messageFilePaths = await this.getAllSlackMessageFilePath(messageDirPath)

      for (const messageFilePath of messageFilePaths) {
        const messages = await this.getSlackMessageFile(messageFilePath)
        const newMessages: Message[] = []
        for (const message of messages) {
          if (
            message.type === undefined ||
            message.text === undefined ||
            message.ts === undefined
          ) {
            throw new Error('Message is missing required parameter')
          }

          // Replace message content
          const { content, urls } = await this.replaceMessageContent(message.text)

          // Get pinned item
          const pinIds = channel.pins ? channel.pins.split(',') : []
          const isPinned = pinIds.includes(message.ts)

          // Get attached file
          const files = message.files
            ? message.files
                // Skip deleted file
                .filter((file) => file.mode !== 'tombstone')
                // Skip file size over max file size
                .filter((file) => file.size && file.size < maxFileSize)
                .map((file) => {
                  if (!file.name || !file.url_private || !file.size || !file.mimetype)
                    throw new Error('File is missing required parameter')

                  return {
                    name: file.name,
                    url: file.url_private,
                    size: file.size,
                    mimetype: file.mimetype,
                  } as File
                })
            : null

          let author: User | null = null
          if (message.bot_id) {
            author = await this.userClient.getBot(slackClient, message.bot_id, message.app_id)
          } else if (message.user === undefined) {
            author = await this.userClient.getBot(slackClient, 'B01', message.app_id)
          } else if (message.user) {
            author = await this.userClient.getUser(slackClient, message.user)
          }

          if (!author) {
            throw new Error(
              [
                'Failed to get message author',
                `Message Timestamp: ${message.ts}`,
                `Message Content: ${content}`,
              ].join('\n')
            )
          }

          newMessages.push({
            timestamp: message.ts,
            deployId: null,
            channelDeployId: channel.deployId,
            threadId: message.thread_ts || null,
            content: content,
            files: files?.length ? JSON.stringify(files) : null,
            urls: urls?.length ? JSON.stringify(urls) : null,
            type: 1,
            isPinned: isPinned,
            isReplyed: message.thread_ts && !message.replies ? true : false,
            authorId: author.id,
            authorName: author.name,
            authorType: author.type,
            authorColor: author.color,
            authorImageUrl: author.imageUrl,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
        }

        await this.updateManyMessage(newMessages)
      }
    }
  }

  /**
   * Deploy all message
   * @param discordClient
   */
  async deployAllMessage(discordClient: DiscordClient) {
    // Get file channel manager
    const fileChannel = await this.channelClient.getChannel('msd-file', 2)
    if (!fileChannel) throw new Error('Failed to get deployed file channel')
    if (!fileChannel.deployId) throw new Error(`Failed to get deployed file channel id`)

    const fileChannelManager = discordClient.channels.cache.get(fileChannel.deployId)
    if (fileChannelManager === undefined || fileChannelManager.type !== ChannelType.GuildText)
      throw new Error('Failed to get file channel manager')

    const channels = await this.channelClient.getAllChannel()
    for (const channel of channels) {
      if (!channel.deployId) throw new Error(`Failed to get deployed channel id of ${channel.name}`)

      const channelManager = discordClient.channels.cache.get(channel.deployId)
      if (channelManager === undefined || channelManager.type !== ChannelType.GuildText)
        throw new Error(`Failed to get channel manager of ${channel.id}`)

      // Pagination message
      const total = await this.client.message.count({
        where: {
          // Get only undeployed message for redeploy
          deployId: { equals: null },
          channelDeployId: channel.deployId,
        },
      })

      const take = 100
      for (let skip = 0; skip < total; skip += take) {
        const messages = await this.client.message.findMany({
          take: take,
          where: {
            deployId: { equals: null },
            channelDeployId: channel.deployId,
          },
          orderBy: {
            timestamp: 'asc',
          },
        })

        await this.deployManyMessage(channelManager, fileChannelManager, messages)
      }
    }
  }

  /**
   * Deploy many message
   * @param channelManager
   * @param fileChannelManager
   * @param messages
   */
  async deployManyMessage(
    channelManager: TextChannel,
    fileChannelManager: TextChannel,
    messages: Message[]
  ) {
    for (const message of messages) {
      const content =
        message.content && message.content.length > 4095
          ? message.content.substring(0, 4095) + '…'
          : message.content

      const timestamp = fromUnixTime(parseFloat(message.timestamp))

      // let authorTypeIcon: '🟢' | '🔵' | '🤖' = '🟢'
      // if (message.authorType === 2) {
      //   authorTypeIcon = '🔵'
      // } else if (message.authorType === 3) {
      //   authorTypeIcon = '🤖'
      // }

      let authorTypeIcon: '' | '🤖' = ''

      if (message.authorType === 3) {
        authorTypeIcon = '🤖'
      }

      const newFiles = message.files
        ? await this.deployManyMessageFile(fileChannelManager, JSON.parse(message.files) as File[])
        : []

      const imageEmbeds: Embed[] = newFiles.length
        ? newFiles
            .filter((file) => file.mimetype.startsWith('image/'))
            .map((file) => ({
              title: `IMAGE: ${file.name}`,
              image: {
                url: file.url,
              },
            }))
        : []

      const fileEmbeds: Embed[] = newFiles.length
        ? newFiles
            .filter((file) => !file.mimetype.startsWith('image/'))
            .map((file) => ({
              title: `FILE: ${file.name}`,
              url: file.url,
            }))
        : []

      const urlEmbeds: Embed[] = message.urls
        ? (JSON.parse(message.urls) as Url[]).map((url) => ({
            title: `URL: ${url.name}`,
            url: url.url,
          }))
        : []

      const embeds: Embed[] = [
        {
          type: EmbedType.Rich,
          color: message.authorColor,
          description: content || undefined,
          timestamp: formatISO(timestamp),
          author: {
            name: `${authorTypeIcon} ${message.authorName}`,
            icon_url: message.authorImageUrl,
          },
          footer: {
            text: format(timestamp, 'yyyy/MM/dd HH:mm'),
          },
        },
        ...imageEmbeds,
        ...fileEmbeds,
        ...urlEmbeds,
      ]

      // If embeds length is over 10, truncate it
      if (embeds.length > 10) {
        // ToDo: Show some warnings?
        embeds.length = 10
      }

      // Deploy message
      let messageManager: MessageManager | undefined = undefined
      if (message.isReplyed && message.threadId) {
        const threadMessage = await this.client.message.findFirst({
          where: {
            timestamp: message.threadId,
          },
        })

        if (!threadMessage)
          throw new Error(
            [
              'Failed to get message to reply',
              'Not found message to reply',
              `Message Timestamp: ${message.timestamp}`,
              `Message Content: ${message.content}`,
            ].join('\n')
          )
        if (!threadMessage.deployId)
          throw new Error(
            [
              'Failed to get message to reply',
              'Not deployed Message to reply',
              `Message Timestamp: ${message.timestamp}`,
              `Message Content: ${message.content}`,
            ].join('\n')
          )

        messageManager = await channelManager.messages.cache.get(threadMessage.deployId)?.reply({
          embeds: embeds,
        })
      } else {
        messageManager = await channelManager.send({
          embeds: embeds,
        })
      }

      if (!messageManager)
        throw new Error(
          [
            'Failed to deploy message',
            'Not found message manager',
            `Message Timestamp: ${message.timestamp}`,
            `Message Content: ${message.content}`,
          ].join('\n')
        )

      // Deploy pinned item
      if (message.isPinned) await messageManager.pin()

      // Update one by one message
      const newMessage = (() => message)()
      newMessage.deployId = messageManager.id
      newMessage.files = newFiles.length ? JSON.stringify(newFiles) : null
      await this.updateManyMessage([newMessage])
    }
  }

  /**
   * Destroy all message
   */
  async destroyAllMessage(discordClient: DiscordClient) {
    //  Get all channel data
    const channels = await this.channelClient.getAllChannel()

    // Delete all messages
    await Promise.all(
      channels.map(async (channel: any) => {
        if (!channel.deployId) throw new Error(`Failed to deployed channel id of ${channel.name}`)

        const channelManager = discordClient.channels.cache.get(channel.deployId)
        if (channelManager === undefined || channelManager.type !== ChannelType.GuildText)
          throw new Error(`Failed to get channel manager of ${channel.id}`)

        // Pagination message
        const total = await this.client.message.count({
          where: {
            channelDeployId: channel.deployId,
          },
        })

        const take = 100
        for (let skip = 0; skip < total; skip += take) {
          const messages = await this.client.message.findMany({
            take: take,
            where: {
              NOT: { deployId: { equals: null } },
              channelDeployId: channel.deployId,
            },
            orderBy: {
              timestamp: 'asc',
            },
          })
          await this.destroyManyMessage(channelManager, messages)
        }
      })
    )
  }

  /**
   * Destroy many message
   * @param channelManager
   * @param messages
   */
  async destroyManyMessage(channelManager: TextChannel, messages: Message[]) {
    const newMessages = await Promise.all(
      messages
        // Skip destroy undeployed message
        .filter((message) => message.deployId)
        .map(async (message) => {
          if (message.isPinned) {
            // FIX: Want to avoid forced type casting
            await channelManager.messages.unpin(message.deployId as string)
          }

          // FIX: Want to avoid forced type casting
          await channelManager.messages.delete(message.deployId as string)

          const newMessage = (() => message)()
          newMessage.deployId = null
          return newMessage
        })
    )
    await this.updateManyMessage(newMessages)
  }

  /**
   * Deploy many message file
   * @param fileChannelManager
   */
  async deployManyMessageFile(fileChannelManager: TextChannel, files: File[]) {
    return await Promise.all(
      files.map(async (file) => {
        // Skip deploy if already hosted file
        let fileUrl = file.url
        let fileSize = file.size
        if (urlParse(file.url).hostname !== 'cdn.discordapp.com') {
          const message = await fileChannelManager.send({
            files: [file.url],
          })
          fileUrl = message.attachments.map((file) => file.url)[0]
          fileSize = message.attachments.map((file) => file.size)[0]
        }

        return {
          name: file.name,
          url: fileUrl,
          size: fileSize,
          mimetype: file.mimetype,
        } as File
      })
    )
  }

  /**
   * Get slack message file
   * @param messageFilePath
   */
  async getSlackMessageFile(messageFilePath: string) {
    await access(messageFilePath, constants.R_OK)
    return JSON.parse(await readFile(messageFilePath, 'utf8')) as SlackMessageFile[]
  }

  /**
   * Get all slack message file path
   * @param messageDirPath
   */
  async getAllSlackMessageFilePath(messageDirPath: string) {
    const fileOrDirNames = await readdir(join(messageDirPath))
    const messageFilePaths = fileOrDirNames
      .filter(
        (fileOrDirName) =>
          // TODO: Replace with async function
          statSync(join(messageDirPath, fileOrDirName)).isFile() &&
          new RegExp(/[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]).json/g).test(fileOrDirName)
      )
      .map((fileOrDirName) => join(messageDirPath, fileOrDirName))
    return messageFilePaths
  }

  /**
   * Replace message content
   * @param content
   */
  async replaceMessageContent(content: string) {
    let newContent = content

    if (!newContent)
      return {
        content: null,
        urls: null,
      }

    // Replace mention
    const mentions = newContent.match(/<@U[A-Z0-9]+?>/g)
    if (mentions?.length) {
      const userIds = mentions.map((mention) => mention.replace(/<@|>/g, ''))
      for (const userId of userIds) {
        const username = await this.userClient.getUsername(userId)
        if (username) {
          newContent = newContent.replaceAll(`<@${userId}>`, `@${username}`)
        } else {
          throw new Error(`Failed to replace mention of @${userId} to username`)
        }
      }
    }

    // Replace channel mention
    if (/<!channel>/.test(newContent)) newContent = newContent.replaceAll(/<!channel>/g, '@channel')

    // Replace bold letters
    if (/\*.*\*/.test(newContent)) newContent = newContent.replaceAll(/\**\*/g, '**')

    //  Replace italic letters
    // if (/\_.*\_/.test(newContent))
    //   newContent = newContent.replaceAll(/\_*\_/g, "_")

    // Replace strikethrough
    if (/~.*~/.test(newContent)) newContent = newContent.replaceAll(/~*~/g, '~~')

    // Replace String with url
    const newUrls: Url[] = []
    const stringWithUrls = newContent.match(/<https?:\/\/.+?\|.+?>/g)
    if (stringWithUrls?.length) {
      for (const stringWithUrl of stringWithUrls) {
        const name = stringWithUrl
          .match(/\|.*>$/g)
          ?.shift()
          ?.slice(1, -1)
        const url = stringWithUrl
          .match(/^<.*\|/g)
          ?.shift()
          ?.slice(1, -1)

        if (!name || !url) throw new Error(`Failed to slice string with url of ${stringWithUrl}`)

        newContent = newContent.replaceAll(stringWithUrl, name)
        newUrls.push({ name: name, url: url })
      }
    }

    // Replace html entities
    // https://api.slack.com/reference/surfaces/formatting#escaping
    const entities = [
      ['&amp;', '&'],
      ['&lt;', '<'],
      ['&gt;', '>'],
    ]
    for (const [from, to] of entities) {
      newContent = newContent.replaceAll(from, to)
    }

    return {
      content: newContent,
      urls: newUrls,
    }
  }

  /**
   * Update many message
   * @param messages
   */
  async updateManyMessage(messages: Message[]) {
    const query = messages.map((message) =>
      this.client.message.upsert({
        where: {
          timestamp: message.timestamp,
        },
        update: {
          deployId: message.deployId,
          channelDeployId: message.channelDeployId,
          threadId: message.threadId,
          content: message.content,
          files: message.files,
          urls: message.urls,
          type: message.type,
          isPinned: message.isPinned,
          isReplyed: message.isReplyed,
          authorId: message.authorId,
          authorName: message.authorName,
          authorType: message.authorType,
          authorColor: message.authorColor,
          authorImageUrl: message.authorImageUrl,
        },
        create: {
          timestamp: message.timestamp,
          deployId: message.deployId,
          channelDeployId: message.channelDeployId,
          threadId: message.threadId,
          content: message.content,
          files: message.files,
          urls: message.urls,
          type: message.type,
          isPinned: message.isPinned,
          isReplyed: message.isReplyed,
          authorId: message.authorId,
          authorName: message.authorName,
          authorType: message.authorType,
          authorColor: message.authorColor,
          authorImageUrl: message.authorImageUrl,
        },
      })
    )

    await this.client.$transaction([...query])
  }
}
