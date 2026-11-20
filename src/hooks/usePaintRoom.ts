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
export function usePaintRoom(scopeId: string) {
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
    const connect = async () => {
      try {
        const token = await getAuthToken()
        if (!alive) return
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = new URL(`/ws/paint/${encodeURIComponent(scopeId)}`, `${protocol}//${window.location.host}`)
        if (token) url.searchParams.set('token', token)
        socket = new WebSocket(url.toString())
        socketRef.current = socket
        socket.onopen = () => { if (alive) setConnected(true) }
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
          }
        }
        socket.onclose = () => {
          if (!alive) return
          setConnected(false); setSelfId(null); setPeers([])
          retry = setTimeout(() => void connect(), 1000)
        }
        socket.onerror = () => socket?.close()
      } catch {
        if (alive) retry = setTimeout(() => void connect(), 1500)
      }
    }
    void connect()
    return () => {
      alive = false
      if (retry) clearTimeout(retry)
      if (socket) { socket.onclose = null; socket.close() }
      socketRef.current = null
    }
  }, [scopeId])

  return { peers, connected, selfId, updateState }
}
