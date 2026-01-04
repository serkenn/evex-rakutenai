import {
  createChatThread,
  fetchAnonymousToken,
  generateDeviceID,
  getSignedWsUrl,
  uploadFile,
} from './core/types'
import type { ChatRequestMessage, ChatResponseStream } from './core/chat-types'

const DEFAULT_AGENT_ID = '6812e64f9dfaf301f7000001'

export class User {
  readonly accessToken: string
  readonly deviceId: string
  constructor(deviceId: string, accessToken: string) {
    this.accessToken = accessToken
    this.deviceId = deviceId
  }
  static async create(): Promise<User> {
    const deviceId = generateDeviceID()
    const i = await fetchAnonymousToken(deviceId)
    return new User(deviceId, i.accessToken)
  }
  async createThread(opts?: { scenarioAgentId?: string; title?: string }): Promise<Thread> {
    const thread = await createChatThread(this.deviceId, this.accessToken, {
      scenarioAgentId: opts?.scenarioAgentId ?? DEFAULT_AGENT_ID,
      title: opts?.title ?? '新しいスレッド',
    })
    const connected = await Thread.connect(thread.id, this)
    return connected
  }
  async uploadFile(opts: {
    file: File
    threadId?: string
  }): Promise<UploadedFile> {
    const res = await uploadFile(this.deviceId, this.accessToken, {
      file: opts.file,
      threadId: opts.threadId ?? crypto.randomUUID(),
    })
    return {
      fileId: res.fileId,
      fileUrl: res.fileUrl,
      fileName: res.originalFilename,
    }
  }
}
export interface UploadedFile {
  fileId: string
  fileUrl: string
  fileName: string
}
export class Thread {
  readonly id: string
  #user: User
  #ws: WebSocket
  #messageStreams: Map<string, ReadableStreamDefaultController<ChatResponseStream>>
  #globalStream: ReadableStream<ChatResponseStream>
  #globalReader: ReadableStreamDefaultReader<ChatResponseStream> | null = null

  constructor(id: string, user: User, ws: WebSocket) {
    this.id = id
    this.#user = user
    this.#ws = ws
    this.#messageStreams = new Map()

    // Global Hyper Steam Management System™
    this.#globalStream = new ReadableStream<ChatResponseStream>({
      start: (controller) => {
        this.#ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as ChatResponseStream
            controller.enqueue(data)
          } catch (error) {
            controller.error(error)
          }
        }
        this.#ws.onerror = (error) => {
          controller.error(error)
        }
        this.#ws.onclose = () => {
          controller.close()
        }
      },
    })

    this.#startDistributing()
  }

  async #startDistributing() {
    this.#globalReader = this.#globalStream.getReader()
    try {
      while (true) {
        const { done, value } = await this.#globalReader.read()
        if (done) break

        if (value.webSocket.type === 'NOTIFICATION' || value.webSocket.type === 'ACK') {
          continue
        }

        const messageId = value.webSocket.metadata.messageId

        if (this.#messageStreams.has(messageId)) {
          const controller = this.#messageStreams.get(messageId)!
          controller.enqueue(value)

          if (
            (value.webSocket.payload.action === 'AI_ANSWER' ||
              value.webSocket.payload.action === 'EVENT') &&
            value.webSocket.payload.data.chatResponseStatus === 'DONE'
          ) {
            controller.close()
            this.#messageStreams.delete(messageId)
          }
        }
      }
    } catch (error) {
      for (const controller of this.#messageStreams.values()) {
        controller.error(error)
      }
    } finally {
      for (const controller of this.#messageStreams.values()) {
        try {
          controller.close()
        } catch {}
      }
      this.#messageStreams.clear()
    }
  }

  static async connect(id: string, user: User): Promise<Thread> {
    const WS_PATH = `/ws/v1/chat?deviceId=${encodeURIComponent(user.deviceId)}`
    const url = await getSignedWsUrl(WS_PATH, user.accessToken)
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = reject
    })
    return new Thread(id, user, ws)
  }

  async *sendMessage(message: {
    mode: 'USER_INPUT' | 'DEEP_THINK' | 'AI_READ'
    contents: (
      | {
          type: 'text'
          text: string
        }
      | {
          type: 'file'
          file: UploadedFile
        }
    )[]
  }): AsyncGenerator<
    | { type: 'text-delta'; text: string }
    | { type: 'reasoning-start' }
    | { type: 'reasoning-delta'; text: string }
    | { type: 'done' }
  > {
    const messageId = crypto.randomUUID()

    const stream = new ReadableStream<ChatResponseStream>({
      start: (controller) => {
        this.#messageStreams.set(messageId, controller)
      },
      cancel: () => {
        this.#messageStreams.delete(messageId)
      },
    })

    this.#ws.send(
      JSON.stringify({
        message: {
          type: 'CONVERSATION',
          payload: {
            action: message.mode,
            data: {
              chatRequestType: message.mode,
              role: 'user',
              userId: this.#user.deviceId,
              threadId: this.id,
              messageId: messageId,
              language: 'ja',
              platform: 'WEB',
              timestamp: Date.now(),
              contents: message.contents.map((c) => {
                if (c.type === 'text') {
                  return {
                    contentType: 'TEXT',
                    textData: {
                      text: c.text,
                    },
                  }
                }
                if (c.type === 'file') {
                  return {
                    contentType: 'INPUT_FILE',
                    inputFileData: {
                      src: c.file.fileUrl,
                      resourceId: c.file.fileId,
                      name: c.file.fileName,
                    },
                  }
                }
                throw new Error('Unsupported content type')
              }),
              retry: false,
              debug: false,
              timezoneString: 'Asia/Tokyo',
              countryCode: 'JP',
              city: 'Nerima',
              explicitSearch: 'AUTO',
            },
          },
          metadata: {
            messageId: messageId,
            timestamp: Date.now(),
          },
        },
      } satisfies ChatRequestMessage),
    )

    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        if (
          chunk.webSocket.payload.action === 'AI_ANSWER' ||
          chunk.webSocket.payload.action === 'EVENT'
        ) {
          if (
            chunk.webSocket.payload.data.chatResponseStatus === 'APPEND' ||
            chunk.webSocket.payload.data.chatResponseStatus === 'TOOL_CALL'
          ) {
            const contents = chunk.webSocket.payload.data.contents
            for (const content of contents) {
              if (content.contentType === 'TEXT') {
                if (chunk.webSocket.payload.action === 'EVENT') {
                  if (content.textData.text === '思考中...') {
                    yield {
                      type: 'reasoning-start',
                    } as const
                    continue
                  } else if (content.textData.text === '検索中...') {
                    // skip
                  }
                  continue
                }
                yield {
                  type: 'text-delta',
                  text: content.textData.text ?? '',
                } as const
              } else if (content.contentType === 'SUMMARY_TEXT') {
                yield {
                  type: 'reasoning-delta',
                  text: content.textData.text ?? '',
                } as const
              } else {
                console.warn(
                  '\n[Unsupported content type:',
                  content.contentType,
                  ']',
                  content,
                )
              }
            }
          } else if (
            chunk.webSocket.payload.data.chatResponseStatus === 'DONE'
          ) {
            yield { type: 'done' } as const
            return
          } else {
            console.warn(
              'Received AI_ANSWER with unsupported chatResponseStatus:',
              chunk.webSocket.payload.data,
            )
          }
        } else {
          console.warn(
            'Received non-AI_ANSWER conversation message:',
            chunk.webSocket,
          )
        }
      }
    } finally {
      reader.releaseLock()
      this.#messageStreams.delete(messageId)
    }
  }
  [Symbol.dispose]() {
    if (this.#globalReader) {
      this.#globalReader.cancel()
    }
    this.#ws.close()
  }
  close() {
    this[Symbol.dispose]()
  }
}
