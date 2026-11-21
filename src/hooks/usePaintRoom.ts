import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuthToken } from 'deepspace'

export interface PaintPeer {
  /** Unique server-issued connection id. Unlike account ids, this distinguishes tabs. */
  userId: string
  userName: string
  joinedAt: string
  state: Record<string, unknown>
}

type PaintMessage = { type: string; payload?: Record<string, unknown> }

/** Game-scoped presence: verified accounts may open more than one roller session. */
export function usePaintRoom(scopeId: string, shouldAuthenticate: boolean) {
  const [peers, setPeers] = useState<PaintPeer[]>([])
  const [connected, setConnected] = useState(false)
  const [selfId, setSelfId] = useState<string | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef<Record<string, unknown>>({})

  const updateState = useCallback((state: Record<string, unknown>) => {
    pendingRef.current = { ...pendingRef.current, ...state }
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'presence.update', payload: state }))
    }
  }, [])

  useEffect(() => {
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    let socket: WebSocket | null = null
    let retryAttempt = 0
    let authWarningShown = false
    let authTokenRetryAfter = 0
    const connect = async () => {
      try {
        const token = shouldAuthenticate && Date.now() >= authTokenRetryAfter ? await getAuthToken() : null
        if (!alive) return
        if (shouldAuthenticate && !token) {
          if (!authWarningShown) console.warn('[PaintWars] DeepSpace did not provide an auth token for the paint room. The room will try an anonymous connection and retry auth in 30 seconds; check the browser session if this is unexpected.')
          authWarningShown = true
          authTokenRetryAfter = Date.now() + 30_000
        } else {
          authWarningShown = false
          authTokenRetryAfter = 0
        }
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = new URL(`/ws/paint/${encodeURIComponent(scopeId)}`, `${protocol}//${window.location.host}`)
        if (token) url.searchParams.set('token', token)
        socket = new WebSocket(url.toString())
        socketRef.current = socket
        socket.onopen = () => { if (alive) { retryAttempt = 0; setConnected(true) } }
        socket.onmessage = (event: MessageEvent<string>) => {
          let message: PaintMessage
          try { message = JSON.parse(event.data) as PaintMessage } catch { return }
          const payload = message.payload ?? {}
          if (message.type === 'presence.sync') {
            setSelfId(typeof payload.selfId === 'string' ? payload.selfId : null)
            setPeers(Array.isArray(payload.peers) ? payload.peers as PaintPeer[] : [])
            if (Object.keys(pendingRef.current).length) {
              socket?.send(JSON.stringify({ type: 'presence.update', payload: pendingRef.current }))
            }
          } else if (message.type === 'presence.join') {
            const peer = payload.peer as PaintPeer | undefined
            if (peer) setPeers(current => [...current.filter(item => item.userId !== peer.userId), peer])
          } else if (message.type === 'presence.update') {
            const id = payload.userId
            const state = payload.state as Record<string, unknown> | undefined
            if (typeof id === 'string' && state) setPeers(current => current.map(peer => peer.userId === id ? { ...peer, state } : peer))
          } else if (message.type === 'presence.leave') {
            const id = payload.userId
            if (typeof id === 'string') setPeers(current => current.filter(peer => peer.userId !== id))
          } else if (message.type === 'core.error') {
            console.error('[PaintWars] Paint room rejected a message:', payload.error ?? payload)
          }
        }
        socket.onclose = (event: CloseEvent) => {
          if (!alive) return
          setConnected(false); setSelfId(null); setPeers([])
          retryAttempt++
          const retryDelay = Math.min(1000 * 2 ** Math.min(retryAttempt - 1, 4), 15000)
          console.warn(`[PaintWars] Paint room disconnected (code ${event.code}${event.reason ? `, ${event.reason}` : ''}, clean: ${event.wasClean}); reconnecting in ${retryDelay} ms.`)
          retry = setTimeout(() => void connect(), retryDelay)
        }
        socket.onerror = () => { console.error('[PaintWars] Paint room WebSocket failed; see the Network panel for the request status and response.'); socket?.close() }
      } catch {
        if (alive) {
          retryAttempt++
          const retryDelay = Math.min(1000 * 2 ** Math.min(retryAttempt - 1, 4), 15000)
          console.error(`[PaintWars] Could not open the paint room; retrying in ${retryDelay} ms.`)
          retry = setTimeout(() => void connect(), retryDelay)
        }
      }
    }
    void connect()
    return () => {
      alive = false
      if (retry) clearTimeout(retry)
      if (socket) { socket.onclose = null; socket.close() }
      socketRef.current = null
    }
  }, [scopeId, shouldAuthenticate])

  return { peers, connected, selfId, updateState }
}
