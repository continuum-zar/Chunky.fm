import { WebSocket } from 'ws'
import type {
  AirMessage,
  ScheduleMessage,
  ChatMessagesMessage,
  ClientMessage,
  FloorMessage,
  HandsMessage,
  HistoryMessage,
  MicMessage,
  PresenceMessage,
  QueueMessage,
  ServerMessage,
  StateMessage,
  WishedMessage,
} from '../src/protocol.js'

const DEFAULT_TIMEOUT_MS = 2_000

interface Waiter {
  predicate: (message: ServerMessage) => boolean
  resolve: (message: ServerMessage) => void
}

/**
 * A listener, for test purposes. Messages are queued rather than sampled, so a
 * frame that arrives before the assertion asks for it is still seen, the usual
 * source of flake in socket tests.
 */
export class TestClient {
  readonly #socket: WebSocket
  readonly #queue: ServerMessage[] = []
  readonly #waiters: Waiter[] = []
  readonly seen: ServerMessage[] = []
  /** Resolves with the close code once the connection ends. */
  readonly closed: Promise<number>

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.on('message', (raw) => this.#receive(JSON.parse(raw.toString()) as ServerMessage))
    this.closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)))
  }

  /** `headers` stands in for what a browser sends on the upgrade: cookies. */
  static connect(url: string, headers?: Record<string, string>): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers })
      const client = new TestClient(socket)
      socket.once('open', () => resolve(client))
      socket.once('error', reject)
    })
  }

  #receive(message: ServerMessage): void {
    this.seen.push(message)
    const index = this.#waiters.findIndex((waiter) => waiter.predicate(message))
    if (index === -1) {
      this.#queue.push(message)
      return
    }
    const [waiter] = this.#waiters.splice(index, 1)
    waiter!.resolve(message)
  }

  /** Consumes and returns the first matching message, waiting if need be. */
  waitFor(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ServerMessage> {
    const queued = this.#queue.findIndex(predicate)
    if (queued !== -1) return Promise.resolve(this.#queue.splice(queued, 1)[0]!)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms waiting for a message`)),
        timeoutMs,
      )
      this.#waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
      })
    })
  }

  async nextAir(timeoutMs?: number): Promise<AirMessage> {
    return (await this.waitFor((m) => m.type === 'air', timeoutMs)) as AirMessage
  }

  async nextSchedule(timeoutMs?: number): Promise<ScheduleMessage> {
    return (await this.waitFor((m) => m.type === 'schedule', timeoutMs)) as ScheduleMessage
  }

  async nextMic(timeoutMs?: number): Promise<MicMessage> {
    return (await this.waitFor((m) => m.type === 'mic', timeoutMs)) as MicMessage
  }

  async nextFloor(timeoutMs?: number): Promise<FloorMessage> {
    return (await this.waitFor((m) => m.type === 'floor', timeoutMs)) as FloorMessage
  }

  /** Only a console ever sees one of these; see `toDecks`. */
  async nextHands(timeoutMs?: number): Promise<HandsMessage> {
    return (await this.waitFor((m) => m.type === 'hands', timeoutMs)) as HandsMessage
  }

  async nextState(timeoutMs?: number): Promise<StateMessage> {
    return (await this.waitFor((m) => m.type === 'state', timeoutMs)) as StateMessage
  }

  async nextQueue(timeoutMs?: number): Promise<QueueMessage> {
    return (await this.waitFor((m) => m.type === 'queue', timeoutMs)) as QueueMessage
  }

  async nextPresence(timeoutMs?: number): Promise<PresenceMessage> {
    return (await this.waitFor((m) => m.type === 'presence', timeoutMs)) as PresenceMessage
  }

  async nextChat(timeoutMs?: number): Promise<ChatMessagesMessage> {
    return (await this.waitFor((m) => m.type === 'chat', timeoutMs)) as ChatMessagesMessage
  }

  async nextHistory(timeoutMs?: number): Promise<HistoryMessage> {
    return (await this.waitFor((m) => m.type === 'history', timeoutMs)) as HistoryMessage
  }

  /** Says something and waits for it to come back around. */
  async say(text: string): Promise<ChatMessagesMessage> {
    this.send({ type: 'say', text })
    return this.nextChat()
  }

  /** Asks for something and waits for the station's note back. */
  async wish(text: string): Promise<WishedMessage> {
    this.send({ type: 'wish', text })
    return (await this.waitFor((m) => m.type === 'wished')) as WishedMessage
  }

  /**
   * Names this listener and waits for the next roster. Messages are queued, so
   * the roster sent on connect has to have been consumed first or it is what
   * this returns; see `arrive` in the presence tests.
   */
  async join(nickname: string): Promise<PresenceMessage> {
    this.send({ type: 'join', nickname })
    return this.nextPresence()
  }

  send(message: ClientMessage | string): void {
    this.#socket.send(typeof message === 'string' ? message : JSON.stringify(message))
  }

  /** Vanishes without a close handshake, the way a dead network does. */
  terminate(): void {
    this.#socket.terminate()
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#socket.readyState === WebSocket.CLOSED) return resolve()
      this.#socket.once('close', () => resolve())
      this.#socket.close()
    })
  }
}

export async function connectAll(url: string, count: number): Promise<TestClient[]> {
  return Promise.all(Array.from({ length: count }, () => TestClient.connect(url)))
}
