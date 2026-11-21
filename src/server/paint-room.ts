import { BaseRoom } from 'deepspace/worker'
import type { ServerMessage, UserAttachment } from 'deepspace/worker'

type PaintAttachment = UserAttachment & {
  paintId: string
  joinedAt: string
  state: Record<string, unknown>
}

type PaintServerMessage = ServerMessage | {
  type: 'presence.sync'
  payload: { selfId: string; peers: unknown[] }
}

/** Presence for roller sessions. A server-issued id lets two tabs on one account play separately. */
export class PaintRoom extends BaseRoom {
  protected sendTo(ws: WebSocket, message: PaintServerMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    } catch {
      // The socket may have closed while the room was preparing the message.
    }
  }

  protected onConnect(ws: WebSocket, user: UserAttachment): PaintAttachment {
    const paintId = crypto.randomUUID()
    const joinedAt = new Date().toISOString()
    const peers = this.getWebSockets()
      .filter(socket => socket !== ws)
      .map(socket => this.getAttachment(socket) as PaintAttachment | null)
      .filter((peer): peer is PaintAttachment => Boolean(peer?.paintId))
      .map(({ paintId: id, userName, joinedAt: joined, state }) => ({ userId: id, userName, joinedAt: joined, state }))
    this.sendTo(ws, { type: 'presence.sync', payload: { selfId: paintId, peers } })
    this.broadcast({ type: 'presence.join', payload: { peer: { userId: paintId, userName: user.userName, joinedAt, state: {} } } }, ws)
    return { ...user, paintId, joinedAt, state: {} }
  }

  protected onMessage(ws: WebSocket, user: UserAttachment, message: { type: string; [key: string]: unknown }): void {
    if (message.type !== 'presence.update') {
      this.sendTo(ws, { type: 'core.error', payload: { error: 'Unknown paint-room message.' } })
      return
    }
    const payload = message.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
    const attachment = user as PaintAttachment
    const state = { ...attachment.state, ...payload as Record<string, unknown> }
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 16 * 1024) return
    const next = { ...attachment, state }
    ws.serializeAttachment(next)
    this.broadcast({ type: 'presence.update', payload: { userId: attachment.paintId, state } }, ws)
  }

  protected onDisconnect(ws: WebSocket, user: UserAttachment): void {
    const attachment = user as PaintAttachment
    if (attachment.paintId) this.broadcast({ type: 'presence.leave', payload: { userId: attachment.paintId } }, ws)
  }
}
