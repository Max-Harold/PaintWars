import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthProfileReady, useMutations, useQuery } from 'deepspace'
import type { RecordData } from 'deepspace'
import { usePaintRoom } from '../../hooks/usePaintRoom'
import '../../styles.css'

const colors = ['#F44336', '#2196F3', '#4CAF50', '#FDD835']
const fieldSize = 72
const arenaSize = 720
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const randomCode = () => Array.from({ length: 4 }, () => codeAlphabet[Math.floor(Math.random() * codeAlphabet.length)]).join('')

type MatchDuration = 30 | 45 | 60
type Lobby = { code: string; visibility: 'public' | 'private'; maxPlayers: number; playerCount: number; status: 'open' | 'playing'; durationSeconds?: MatchDuration; botCount?: number }
type Position = { x: number; y: number; angle: number; color: string }
type Segment = { id: string; fromX: number; fromY: number; x: number; y: number; color: string }
type RoundPlayer = { id: string; name: string; color: string }
type BotState = { id: string; name: string; color: string; x: number; y: number; angle: number; previousX: number; previousY: number; targetX: number; targetY: number; nextTargetAt: number }
type RoundResult = RoundPlayer & { share: number; departed: boolean }
type LobbyRecord = RecordData<Lobby>

function spawnForColor(color: string): Position {
  const inset = 44
  const center = arenaSize / 2
  switch (colors.indexOf(color)) {
    case 1: return { x: arenaSize - inset, y: center, angle: Math.PI, color }
    case 2: return { x: center, y: inset, angle: Math.PI / 2, color }
    case 3: return { x: center, y: arenaSize - inset, angle: -Math.PI / 2, color }
    default: return { x: inset, y: center, angle: 0, color }
  }
}

function recordPaint(owners: Int8Array, segment: Pick<Segment, 'fromX' | 'fromY' | 'x' | 'y' | 'color'>) {
  const colorIndex = Math.max(0, colors.indexOf(segment.color))
  const length = Math.hypot(segment.x-segment.fromX, segment.y-segment.fromY)
  const steps = Math.max(1, Math.ceil(length / 8))
  for (let step=0;step<=steps;step++) {
    const t=step/steps, x=Math.floor((segment.fromX+(segment.x-segment.fromX)*t)/arenaSize*fieldSize), y=Math.floor((segment.fromY+(segment.y-segment.fromY)*t)/arenaSize*fieldSize)
    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){const px=x+ox,py=y+oy;if(px>=0&&py>=0&&px<fieldSize&&py<fieldSize&&ox*ox+oy*oy<=2)owners[py*fieldSize+px]=colorIndex}
  }
}

function formatTimer(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function chooseBotTarget(bot: BotState, owners: Int8Array) {
  let best = { x: arenaSize / 2, y: arenaSize / 2, score: Number.NEGATIVE_INFINITY }
  for (let candidate = 0; candidate < 18; candidate++) {
    const x = 52 + Math.random() * (arenaSize - 104)
    const y = 52 + Math.random() * (arenaSize - 104)
    const cellX = Math.floor(x / arenaSize * fieldSize)
    const cellY = Math.floor(y / arenaSize * fieldSize)
    let painted = 0
    for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
      const px = cellX + ox, py = cellY + oy
      if (px >= 0 && py >= 0 && px < fieldSize && py < fieldSize && owners[py * fieldSize + px] >= 0) painted++
    }
    const distance = Math.hypot(x - bot.x, y - bot.y)
    const score = (25 - painted) * 4 + Math.min(distance, 300) * 0.025 + Math.random() * 5
    if (score > best.score) best = { x, y, score }
  }
  return best
}

function electLeader(roomCode: string, departedId: string, members: string[]) {
  const candidates = [...new Set(members)].sort()
  if (!candidates.length) return ''
  const seed = `${roomCode}:${departedId}`
  let hash = 2166136261
  for (let i=0;i<seed.length;i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619)
  return candidates[(hash >>> 0) % candidates.length]
}

export default function HomePage() {
  const { user, isSignedIn } = useAuthProfileReady({ requireUser: true })
  const { records: lobbies, status: lobbyStatus } = useQuery<Lobby>('lobbies', { orderBy: 'createdAt', orderDir: 'desc', limit: 40 })
  const { createConfirmed, putConfirmed, removeConfirmed, ready: lobbyWritesReady } = useMutations<Lobby>('lobbies')
  const [room, setRoom] = useState<LobbyRecord | null>(null)
  const [isHost, setIsHost] = useState(false)
  const [isSolo, setIsSolo] = useState(false)
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [maxPlayers, setMaxPlayers] = useState(4)
  const [matchDuration, setMatchDuration] = useState<MatchDuration>(30)
  const [botCount, setBotCount] = useState(1)
  const [joinCode, setJoinCode] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const publicLobbies = useMemo(() => lobbies.filter(r => r.data.visibility === 'public' && Date.now() - Date.parse(r.createdAt) < 10 * 60 * 1000), [lobbies])

  const createRoom = async () => {
    if (!lobbyWritesReady || busy) return
    setBusy(true); setMessage('')
    try {
      const code = randomCode()
      const id = await createConfirmed({ code, visibility, maxPlayers, playerCount: 1, status: 'open', durationSeconds: matchDuration })
      setRoom({ recordId: id, data: { code, visibility, maxPlayers, playerCount: 1, status: 'open', durationSeconds: matchDuration }, createdBy: user?.id ?? '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      setIsHost(true); setIsSolo(false)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not create this lobby.') }
    finally { setBusy(false) }
  }

  const joinByCode = (code: string) => {
    const normalized = code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)
    if (normalized.length !== 4) { setMessage('Enter a four-letter lobby code.'); return }
    const found = lobbies.find(r => r.data.code === normalized)
    if (found && found.data.visibility === 'public') { setRoom(found); setIsHost(false); setIsSolo(false); setMessage(''); return }
    // Private room codes are invite secrets: they are intentionally absent from the public lobby query.
    setRoom({ recordId: '', data: { code: normalized, visibility: 'private', maxPlayers: 4, playerCount: 1, status: 'open' }, createdBy: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    setIsHost(false); setIsSolo(false); setMessage('')
  }

  const joinRandom = () => {
    const candidate = publicLobbies.find(r => r.data.status === 'open' && r.data.playerCount < r.data.maxPlayers)
    if (!candidate) { setMessage('No public lobbies are open right now. Create one and invite a friend!'); return }
    setRoom(candidate); setIsHost(false); setIsSolo(false); setMessage('')
  }

  const startPractice = (opponents = 0) => {
    setRoom({ recordId: '', data: { code: randomCode(), visibility: 'private', maxPlayers: 1, playerCount: 1, status: 'open', durationSeconds: matchDuration, botCount: opponents }, createdBy: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    setIsHost(true); setIsSolo(true)
  }

  const updateLobby = useCallback(async (patch: Partial<Lobby>) => {
    if (isHost && room?.recordId && lobbyWritesReady) {
      try { await putConfirmed(room.recordId, patch) } catch { /* Live presence still works if the directory update is delayed. */ }
    }
  }, [isHost, lobbyWritesReady, putConfirmed, room?.recordId])

  const leaveRoom = async (keepLobby = false) => {
    if (isHost && !keepLobby && room?.recordId && lobbyWritesReady) {
      try { await removeConfirmed(room.recordId) } catch { /* The room can still be left if lobby cleanup fails. */ }
    }
    setRoom(null); setIsHost(false); setMessage('')
  }

  if (!room) return <LobbyHome userName={user?.name ?? 'PLAYER'} publicLobbies={publicLobbies} lobbyStatus={lobbyStatus} writesReady={lobbyWritesReady} busy={busy} visibility={visibility} setVisibility={setVisibility} maxPlayers={maxPlayers} setMaxPlayers={setMaxPlayers} matchDuration={matchDuration} setMatchDuration={setMatchDuration} botCount={botCount} setBotCount={setBotCount} joinCode={joinCode} setJoinCode={setJoinCode} message={message} onCreate={createRoom} onJoin={joinByCode} onRandom={joinRandom} onPractice={startPractice} />

  return <MatchRoom key={`${room.recordId || room.data.code}`} room={room.data} isHost={isHost} solo={isSolo} authenticated={isSignedIn} userName={user?.name ?? 'PLAYER'} onLeave={leaveRoom} onLobbyUpdate={updateLobby} />
}

function LobbyHome({ userName, publicLobbies, lobbyStatus, writesReady, busy, visibility, setVisibility, maxPlayers, setMaxPlayers, matchDuration, setMatchDuration, botCount, setBotCount, joinCode, setJoinCode, message, onCreate, onJoin, onRandom, onPractice }: {
  userName: string; publicLobbies: LobbyRecord[]; lobbyStatus: string; writesReady: boolean; busy: boolean
  visibility: 'public' | 'private'; setVisibility: (value: 'public' | 'private') => void
  maxPlayers: number; setMaxPlayers: (value: number) => void; joinCode: string; setJoinCode: (value: string) => void
  matchDuration: MatchDuration; setMatchDuration: (value: MatchDuration) => void
  botCount: number; setBotCount: (value: number) => void
  message: string; onCreate: () => void; onJoin: (code: string) => void; onRandom: () => void; onPractice: (botCount: number) => void
}) {
  return <main className="paint-app"><header className="topbar"><a className="brand" href="/home"><img className="brand-logo" src="/paintwars-logo.png" alt="" /> PAINT<span>WARS</span></a><div className="top-actions"><span className="online-dot"/> MULTIPLAYER ARENA <span className="divider"/> {userName.split(' ')[0]} <span className="avatar">P</span></div></header>
    <section className="intro"><div><p className="eyebrow">A COLOR CONTROL GAME</p><h1>Color the <em>arena.</em></h1><p className="subhead">Create a room, invite friends, and take control of the floor.</p></div><div className="mode-pill">● &nbsp;MULTIPLAYER</div></section>
    <section className="lobby-grid"><div className="panel lobby-panel"><p className="label">START A MATCH</p><h2>Make a lobby</h2><p className="lobby-copy">Choose who can find your room and how many rollers can join.</p><div className="segmented"><button className={visibility==='public'?'selected':''} onClick={()=>setVisibility('public')}>PUBLIC</button><button className={visibility==='private'?'selected':''} onClick={()=>setVisibility('private')}>PRIVATE</button></div><label className="form-label" htmlFor="players">PLAYER SLOTS</label><select id="players" className="lobby-select" value={maxPlayers} onChange={e=>setMaxPlayers(Number(e.target.value))}><option value={2}>2 players</option><option value={3}>3 players</option><option value={4}>4 players</option></select><label className="form-label" id="match-duration-label">MATCH LENGTH</label><div className="segmented duration-options" role="group" aria-labelledby="match-duration-label">{([30,45,60] as const).map(value=><button key={value} type="button" aria-pressed={matchDuration===value} className={matchDuration===value?'selected':''} onClick={()=>setMatchDuration(value)}>{value===60?'1 MIN':`${value} SEC`}</button>)}</div><button className="start-btn" disabled={!writesReady||busy} onClick={onCreate}>{busy?'CREATING…':'CREATE LOBBY'} <span>↗</span></button></div>
    <div className="panel lobby-panel"><p className="label">JOIN THE ACTION</p><h2>Find your friends</h2><p className="lobby-copy">Enter the four-letter code from your host, or jump into a public game.</p><label className="form-label" htmlFor="room-code">LOBBY CODE</label><div className="code-join"><input id="room-code" value={joinCode} maxLength={4} placeholder="ABCD" onChange={e=>setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z]/g,'').slice(0,4))} onKeyDown={e=>e.key==='Enter'&&onJoin(joinCode)} /><button onClick={()=>onJoin(joinCode)}>JOIN CODE</button></div><button className="random-btn" onClick={onRandom}>⤨ &nbsp; JOIN RANDOM PUBLIC LOBBY</button><p className="lobby-copy small-copy">{lobbyStatus==='ready'?`${publicLobbies.length} public room${publicLobbies.length===1?'':'s'} found`:'Looking for open rooms…'}</p><label className="form-label" htmlFor="bot-count">BOT OPPONENTS</label><select id="bot-count" className="lobby-select" value={botCount} onChange={e=>setBotCount(Number(e.target.value))}><option value={1}>1 bot</option><option value={2}>2 bots</option><option value={3}>3 bots</option></select><button className="practice-btn bot-play-btn" onClick={()=>onPractice(botCount)}>PLAY AGAINST BOTS</button><button className="practice-btn" onClick={()=>onPractice(0)}>PRACTICE SOLO</button></div></section>
    {publicLobbies.some(r=>r.data.status==='open'&&r.data.playerCount<r.data.maxPlayers)&&<section className="public-list"><p className="label">OPEN PUBLIC ROOMS</p>{publicLobbies.filter(r=>r.data.status==='open'&&r.data.playerCount<r.data.maxPlayers).map(r=><button className="public-room" key={r.recordId} onClick={()=>onJoin(r.data.code)}><span><b>{r.data.code}</b><small>{r.data.playerCount}/{r.data.maxPlayers} rollers · public</small></span><strong>JOIN ↗</strong></button>)}</section>}
    {message&&<p className="lobby-message" role="status">{message}</p>}<footer className="footer"><span>CONTROL THE MOST FLOOR</span><span>PLAY SOLO OR WITH FRIENDS</span></footer></main>
}

function MatchRoom({ room, isHost, solo, authenticated, userName, onLeave, onLobbyUpdate }: { room: Lobby; isHost: boolean; solo: boolean; authenticated: boolean; userName: string; onLeave: (keepLobby?: boolean) => void; onLobbyUpdate: (patch: Partial<Lobby>) => Promise<void> }) {
  const { peers, connected, selfId, updateState } = usePaintRoom(`paint:${room.code}`, authenticated)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const trailRef = useRef<HTMLCanvasElement | null>(null)
  const ownersRef = useRef(new Int8Array(fieldSize * fieldSize).fill(-1))
  const rollerRef = useRef({ x: arenaSize / 2, y: arenaSize / 2, angle: -Math.PI / 2, turn: 0, previousX: arenaSize / 2, previousY: arenaSize / 2, lastSentX: arenaSize / 2, lastSentY: arenaSize / 2 })
  const peersRef = useRef(peers)
  const rosterCountRef = useRef(0)
  const seenSegmentsRef = useRef(new Map<string, string>())
  const remoteTrailPositionsRef = useRef(new Map<string, { x: number; y: number }>())
  const segmentIdRef = useRef(0)
  const sessionIdRef = useRef('')
  const roundRosterRef = useRef<RoundPlayer[]>([])
  const botStatesRef = useRef<BotState[]>([])
  const lastStartRef = useRef<number | null>(null)
  const appliedResultStartRef = useRef<number | null>(null)
  const [running, setRunning] = useState(false)
  const [matchDuration, setMatchDuration] = useState<MatchDuration>(room.durationSeconds ?? 30)
  const [seconds, setSeconds] = useState<number>(room.durationSeconds ?? 30)
  const [shares, setShares] = useState([0, 0, 0, 0])
  const [finalResults, setFinalResults] = useState<RoundResult[]>([])
  const [copyStatus, setCopyStatus] = useState('COPY CODE')
  const [color, setColor] = useState(colors[0])
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [leaderId, setLeaderId] = useState<string | null>(null)
  const botCount = solo ? room.botCount ?? 0 : 0
  const isLeader = Boolean(selfId && leaderId === selfId)
  const isFull = !solo && peers.length + 1 > room.maxPlayers
  const roundComplete = !running && finalResults.length > 0
  const soloTitle = botCount ? `SOLO VS ${botCount} BOT${botCount === 1 ? '' : 'S'}` : 'SOLO PRACTICE'
  const soloDescription = botCount ? `Paint against ${botCount} bot${botCount === 1 ? '' : 's'}. Use the left/right arrows or A/D to steer.` : 'Your own endless practice floor.'
  const finishRound = useCallback(() => {
    const scores = [0, 0, 0, 0]
    for (const owner of ownersRef.current) if (owner >= 0) scores[owner]++
    const activeIds = new Set([...(selfId ? [selfId] : []), ...peersRef.current.map(peer => peer.userId)])
    const results = roundRosterRef.current.map(player => ({
      ...player,
      share: Math.round((scores[colors.indexOf(player.color)] ?? 0) / ownersRef.current.length * 100),
      departed: !activeIds.has(player.id) && !player.id.startsWith('bot-'),
    }))
    setShares(scores.map(count => Math.round(count / ownersRef.current.length * 100)))
    setFinalResults(results)
    console.info('[PaintWars] Finalized round locally.', { players: results.length })
    setSeconds(0)
    setRunning(false)
    if (isLeader) updateState({ phase: 'finished', results })
  }, [isLeader, selfId, updateState])

  const paintBackground = (ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = '#f3eee4'; ctx.fillRect(0, 0, arenaSize, arenaSize)
    ctx.strokeStyle = 'rgba(78,72,57,.045)'; ctx.lineWidth = 1
    for (let x=0;x<=arenaSize;x+=36){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,arenaSize);ctx.stroke()}
    for (let y=0;y<=arenaSize;y+=36){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(arenaSize,y);ctx.stroke()}
  }
  const drawRoller = (ctx: CanvasRenderingContext2D, pos: {x:number;y:number;angle:number}, paintColor: string) => {
    ctx.save();ctx.translate(pos.x,pos.y);ctx.rotate(pos.angle+Math.PI/2);ctx.scale(1.55,1.55);ctx.strokeStyle='#37372f';ctx.lineWidth=3;ctx.lineCap='round';ctx.lineJoin='round'
    ctx.beginPath();ctx.moveTo(0,-5);ctx.lineTo(0,12);ctx.lineTo(4,20);ctx.stroke();ctx.beginPath();ctx.moveTo(-13,-9);ctx.lineTo(-13,-15);ctx.lineTo(13,-15);ctx.lineTo(13,-9);ctx.stroke()
    ctx.fillStyle=paintColor;ctx.strokeStyle='#37372f';ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(-16,-22,32,12,5);ctx.fill();ctx.stroke();ctx.strokeStyle='rgba(255,248,235,.72)';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-10,-16);ctx.lineTo(10,-16);ctx.stroke();ctx.restore()
  }

  useEffect(()=>{peersRef.current=peers},[peers])
  useEffect(()=>{if(isHost&&connected&&selfId&&!leaderId)setLeaderId(selfId)},[connected,isHost,leaderId,selfId])
  useEffect(()=>{if(connected&&selfId&&leaderId)updateState({leaderId,...(isLeader?{lobbyDurationSeconds:matchDuration}:{})})},[connected,isLeader,leaderId,matchDuration,selfId,updateState])
  useEffect(()=>{
    if(isLeader||running)return
    const leader=peers.find(peer=>peer.userId===leaderId)
    const duration=leader?.state.lobbyDurationSeconds
    if(duration===30||duration===45||duration===60){setMatchDuration(duration);setSeconds(duration)}
  },[isLeader,leaderId,peers,running])
  useEffect(()=>{
    const connectedIds=new Set([...(selfId?[selfId]:[]),...peers.map(peer=>peer.userId)])
    const announced=peers.map(peer=>peer.state.leaderId).find(id=>typeof id==='string'&&connectedIds.has(id)) as string|undefined
    if(!isHost&&announced&&announced!==leaderId){setLeaderId(announced);updateState({leaderId:announced})}
  },[isHost,leaderId,peers,selfId,updateState])
  useEffect(()=>{
    if(solo||!selfId||!leaderId||leaderId===selfId||peers.some(peer=>peer.userId===leaderId))return
    const next=electLeader(room.code,leaderId,[selfId,...peers.map(peer=>peer.userId)])
    if(next){setLeaderId(next);updateState({leaderId:next})}
  },[leaderId,peers,room.code,selfId,solo,updateState])
  useEffect(()=>{
    if(solo||!running||peers.length>0)return
    const timeout=window.setTimeout(()=>finishRound(),1800)
    return()=>window.clearTimeout(timeout)
  },[finishRound,peers.length,running,solo])
  useEffect(()=>{if(!isLeader||!connected)return;const count=peers.length+1;if(rosterCountRef.current===count)return;rosterCountRef.current=count;void onLobbyUpdate({playerCount:count})},[connected,isLeader,onLobbyUpdate,peers.length])
  useEffect(()=>{const canvas=canvasRef.current;const ctx=canvas?.getContext('2d');if(!canvas||!ctx)return;const trail=document.createElement('canvas');trail.width=arenaSize;trail.height=arenaSize;trailRef.current=trail;paintBackground(ctx);drawRoller(ctx,rollerRef.current,color)},[])
  useEffect(()=>{
    const trail=trailRef.current?.getContext('2d');if(!trail)return
    for(const peer of peers){const segment=peer.state.segment as Segment|undefined;if(!segment||seenSegmentsRef.current.get(peer.userId)===segment.id)continue
      seenSegmentsRef.current.set(peer.userId,segment.id)
      const previous=remoteTrailPositionsRef.current.get(peer.userId)
      const connectedSegment={...segment,fromX:previous?.x??segment.fromX,fromY:previous?.y??segment.fromY}
      remoteTrailPositionsRef.current.set(peer.userId,{x:segment.x,y:segment.y})
      trail.strokeStyle=segment.color;trail.globalAlpha=.88;trail.lineWidth=31;trail.lineCap='round';trail.lineJoin='round';trail.beginPath();trail.moveTo(connectedSegment.fromX,connectedSegment.fromY);trail.lineTo(connectedSegment.x,connectedSegment.y);trail.stroke();trail.globalAlpha=1;recordPaint(ownersRef.current,connectedSegment)
    }
  },[peers])
  const startRound=useCallback((when=Date.now(),sharedColors?:Record<string,string>,sharedRoster?:RoundPlayer[],sharedDuration?:MatchDuration)=>{
    const canvas=canvasRef.current,ctx=canvas?.getContext('2d');if(!ctx)return
    if(!selfId)return
    const members=[selfId,...peersRef.current.map(peer=>peer.userId),...(solo?Array.from({length:room.botCount??0},(_,index)=>`bot-${index+1}`):[])]
    const previousColors=new Map(roundRosterRef.current.map(player=>[player.id,player.color]))
    const playerColors:Record<string,string>={...(sharedColors??{})}
    if(!sharedColors){
      const usedColors=new Set<string>()
      for(const member of members){const previousColor=previousColors.get(member);if(previousColor&&!usedColors.has(previousColor)){playerColors[member]=previousColor;usedColors.add(previousColor)}}
      for(const member of members){if(playerColors[member])continue;const available=colors.find(candidate=>!usedColors.has(candidate))??colors[members.indexOf(member)%colors.length];playerColors[member]=available;usedColors.add(available)}
    }
    const roster=sharedRoster??members.map((id,index)=>({id,name:id===selfId?userName:id.startsWith('bot-')?`BOT ${id.slice(4)}`:(peersRef.current.find(peer=>peer.userId===id)?.userName||`PLAYER ${index+1}`),color:playerColors[id]??colors[index%colors.length]}))
    roundRosterRef.current=roster;setFinalResults([])
    const nextColor=playerColors[selfId]??colors[Math.max(0,members.indexOf(selfId))%colors.length];setColor(nextColor)
    const spawn=spawnForColor(nextColor)
    botStatesRef.current=roster.filter(player=>player.id.startsWith('bot-')).map(player=>{const botSpawn=spawnForColor(player.color);return{id:player.id,name:player.name,color:player.color,x:botSpawn.x,y:botSpawn.y,angle:botSpawn.angle,previousX:botSpawn.x,previousY:botSpawn.y,targetX:arenaSize/2,targetY:arenaSize/2,nextTargetAt:0}})
    ownersRef.current.fill(-1);trailRef.current?.getContext('2d')?.clearRect(0,0,arenaSize,arenaSize);paintBackground(ctx);sessionIdRef.current=`${Date.now()}-${Math.random().toString(36).slice(2)}`;segmentIdRef.current=0;seenSegmentsRef.current.clear();remoteTrailPositionsRef.current.clear()
    rollerRef.current={x:spawn.x,y:spawn.y,angle:spawn.angle,turn:0,previousX:spawn.x,previousY:spawn.y,lastSentX:spawn.x,lastSentY:spawn.y}
    const roundDuration=sharedDuration??matchDuration
    setMatchDuration(roundDuration)
    lastStartRef.current=when;appliedResultStartRef.current=null;setStartedAt(when);setSeconds(Math.max(0,roundDuration-Math.floor((Date.now()-when)/1000)));setRunning(true)
    if(isLeader&&!solo)void onLobbyUpdate({status:'playing'})
    updateState({phase:'playing',startedAt:when,durationSeconds:roundDuration,playerColors,roundRoster:roster,segment:null,position:spawn})
  },[isLeader,matchDuration,onLobbyUpdate,room.botCount,selfId,solo,updateState,userName])
  useEffect(()=>{const startFromHost=peers.find(p=>p.state.phase==='playing'&&typeof p.state.startedAt==='number'&&p.state.startedAt!==lastStartRef.current);if(startFromHost&&!running)startRound(startFromHost.state.startedAt as number,startFromHost.state.playerColors as Record<string,string>|undefined,startFromHost.state.roundRoster as RoundPlayer[]|undefined,startFromHost.state.durationSeconds as MatchDuration|undefined)},[peers,running,startRound])
  useEffect(()=>{
    const finished=peers.find(peer=>peer.state.phase==='finished'&&Array.isArray(peer.state.results)&&typeof peer.state.startedAt==='number')
    if(!finished)return
    const finishedStart=finished.state.startedAt as number
    if(lastStartRef.current!==null&&finishedStart!==lastStartRef.current)return
    if(appliedResultStartRef.current===finishedStart)return
    const results=finished.state.results as RoundResult[]
    appliedResultStartRef.current=finishedStart
    console.info('[PaintWars] Received completed round results from another player.', { players: results.length, startedAt: finishedStart })
    setFinalResults(results);setSeconds(0);setRunning(false)
    const scores=[0,0,0,0]
    for(const result of results)scores[colors.indexOf(result.color)]=Math.round(result.share*ownersRef.current.length/100)
    setShares(scores.map(count=>Math.round(count/ownersRef.current.length*100)))
  },[peers])
  useEffect(()=>{if((seconds!==0&&!roundComplete)||running)return;const canvas=canvasRef.current,ctx=canvas?.getContext('2d');if(!ctx||!trailRef.current)return;paintBackground(ctx);ctx.drawImage(trailRef.current,0,0)},[seconds,running,roundComplete])
  useEffect(()=>{
    const setTurn=(event:KeyboardEvent,down:boolean)=>{const key=event.key.toLowerCase();if(key!=='arrowleft'&&key!=='arrowright'&&key!=='a'&&key!=='d')return;event.preventDefault();rollerRef.current.turn=down?(key==='arrowleft'||key==='a'?-1:1):0}
    const down=(e:KeyboardEvent)=>setTurn(e,true),up=(e:KeyboardEvent)=>setTurn(e,false);window.addEventListener('keydown',down);window.addEventListener('keyup',up);return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up)}
  },[])
  useEffect(()=>{
    if(!running||seconds<=0)return
    let last=0,ticks=0,raf=0;const canvas=canvasRef.current,trailCanvas=trailRef.current,ctx=canvas?.getContext('2d'),trail=trailCanvas?.getContext('2d');if(!canvas||!ctx||!trail||!trailCanvas)return
    const animate=(time:number)=>{if(!last)last=time;const dt=Math.min((time-last)/1000,.04);last=time;const p=rollerRef.current;p.angle+=p.turn*3.5*dt;p.x=Math.max(22,Math.min(arenaSize-22,p.x+Math.cos(p.angle)*300*dt));p.y=Math.max(22,Math.min(arenaSize-22,p.y+Math.sin(p.angle)*300*dt))
      trail.strokeStyle=color;trail.globalAlpha=.88;trail.lineWidth=31;trail.lineCap='round';trail.beginPath();trail.moveTo(p.previousX,p.previousY);trail.lineTo(p.x,p.y);trail.stroke();trail.globalAlpha=1
      recordPaint(ownersRef.current,{fromX:p.previousX,fromY:p.previousY,x:p.x,y:p.y,color});p.previousX=p.x;p.previousY=p.y
      for(const bot of botStatesRef.current){
        if(time>=bot.nextTargetAt||Math.hypot(bot.targetX-bot.x,bot.targetY-bot.y)<34){const target=chooseBotTarget(bot,ownersRef.current);bot.targetX=target.x;bot.targetY=target.y;bot.nextTargetAt=time+2200+Math.random()*2200}
        const desired=Math.atan2(bot.targetY-bot.y,bot.targetX-bot.x)
        const turn=((desired-bot.angle+Math.PI*3)%(Math.PI*2))-Math.PI
        bot.angle+=Math.max(-2.35*dt,Math.min(2.35*dt,turn))
        bot.x=Math.max(22,Math.min(arenaSize-22,bot.x+Math.cos(bot.angle)*265*dt))
        bot.y=Math.max(22,Math.min(arenaSize-22,bot.y+Math.sin(bot.angle)*265*dt))
        trail.strokeStyle=bot.color;trail.globalAlpha=.88;trail.lineWidth=31;trail.lineCap='round';trail.lineJoin='round';trail.beginPath();trail.moveTo(bot.previousX,bot.previousY);trail.lineTo(bot.x,bot.y);trail.stroke();trail.globalAlpha=1
        recordPaint(ownersRef.current,{fromX:bot.previousX,fromY:bot.previousY,x:bot.x,y:bot.y,color:bot.color})
        bot.previousX=bot.x;bot.previousY=bot.y
      }
      ticks++
      if(ticks%6===0){const segment:Segment={id:`${sessionIdRef.current}:${++segmentIdRef.current}`,fromX:p.lastSentX,fromY:p.lastSentY,x:p.x,y:p.y,color};p.lastSentX=p.x;p.lastSentY=p.y;updateState({position:{x:p.x,y:p.y,angle:p.angle,color},segment})}
      paintBackground(ctx);ctx.drawImage(trailCanvas,0,0);drawRoller(ctx,p,color)
      for(const peer of peersRef.current){const pos=peer.state.position as Position|undefined;if(pos)drawRoller(ctx,pos,pos.color)}
      for(const bot of botStatesRef.current)drawRoller(ctx,bot,bot.color)
      if(ticks%12===0){const scores=[0,0,0,0];for(const owner of ownersRef.current)if(owner>=0)scores[owner]++;setShares(scores.map(n=>Math.round(n/ownersRef.current.length*100)))}
      raf=requestAnimationFrame(animate)
    };raf=requestAnimationFrame(animate);return()=>cancelAnimationFrame(raf)
  },[running,seconds,color,updateState])
  useEffect(()=>{if(!running||startedAt===null)return;const timer=window.setInterval(()=>{const remaining=Math.max(0,matchDuration-Math.floor((Date.now()-startedAt)/1000));setSeconds(remaining);if(remaining===0)finishRound()},250);return()=>clearInterval(timer)},[running,startedAt,matchDuration,finishRound])

  const copyRoomCode = async () => {
    try {
      await navigator.clipboard.writeText(room.code)
      setCopyStatus('COPIED')
      window.setTimeout(() => setCopyStatus('COPY CODE'), 1600)
    } catch {
      setCopyStatus('COPY FAILED')
      window.setTimeout(() => setCopyStatus('COPY CODE'), 1600)
    }
  }

  const steer=(direction:number)=>{rollerRef.current.turn=direction}
  return <main className="paint-app"><header className="topbar"><button className="back-link" onClick={()=>onLeave()}>← LOBBIES</button><div className="top-actions"><span className={connected?'online-dot':'offline-dot'}/>{connected?'ROOM CONNECTED':'CONNECTING'}</div></header>
    <section className="intro"><div><p className="eyebrow">{solo?soloTitle:`${room.visibility==='public'?'PUBLIC LOBBY':'PRIVATE LOBBY'} · ${Math.min(peers.length+1,room.maxPlayers)}/${room.maxPlayers} ROLLERS`}</p><h1>Paint the <em>whole</em> board.</h1><p className="subhead">{solo?soloDescription:'Invite friends to join. Use the left/right arrows or A/D to steer.'}</p>{!solo&&<div className="code-share"><span className="code-share-label">LOBBY CODE</span><strong className="code-share-value">{room.code}</strong><button className="copy-code-btn" onClick={()=>void copyRoomCode()}>{copyStatus}</button></div>}</div><div className="mode-pill">● &nbsp;{running?'LIVE MATCH':isFull?'ROOM FULL':'WAITING ROOM'}</div></section>
    <section className="game-layout"><aside className="panel"><p className="label">ROUND STATUS</p><div className="timer">{formatTimer(seconds)}</div><div className="status-line"><span className={connected?'online-dot':'offline-dot'}/>{running?'ROUND IN PROGRESS':(roundComplete||seconds===0)?'ROUND COMPLETE':'WAITING TO START'}</div><div className="panel-rule"/><p className="label">{roundComplete||seconds===0?'FINAL PAINT SHARE':'PLAYERS IN ROOM'}</p>{(roundComplete||seconds===0)&&finalResults.length?finalResults.map(result=><div className="score" key={result.id}><span className="swatch" style={{background:result.color}}/><span>{result.name}{result.departed?' (LEFT)':''}</span><b>{result.share}%</b></div>):<><div className="score"><span className="swatch" style={{background:color}}/><span>{userName.split(' ')[0]} (YOU){isLeader?' Â· LEADER':''}</span><b>—</b></div>{peers.map((peer,i)=>{const pos=peer.state.position as Position|undefined;const c=pos?.color??colors[(i+1)%colors.length];return <div className="score" key={peer.userId}><span className="swatch" style={{background:c}}/><span>{peer.userName||`PLAYER ${i+2}`}{peer.userId===leaderId?' Â· LEADER':''}</span><b>—</b></div>})}</>}
      {isFull&&<p className="room-full" role="status">This lobby is full. Leave and join another room.</p>}{isLeader&&!running&&(roundComplete||seconds===matchDuration||seconds===0)&&<button className="start-btn" disabled={!connected||(!solo&&(peers.length===0||isFull))} onClick={()=>startRound(Date.now())}>{roundComplete||seconds===0?'START NEW GAME':solo?'START PRACTICE':peers.length===0?'WAITING FOR A FRIEND':'START MATCH'} <span>↗</span></button>}{!isLeader&&!solo&&!running&&(roundComplete||seconds===matchDuration||seconds===0)&&<p className="hint">{roundComplete||seconds===0?'The paint stays on the floor. Waiting for the lobby leader to start another game.':peers.length===0?'No leader is visible yet. Check the code, or wait for the leader to reconnect.':'Waiting for the lobby leader to start the match.'}</p>}<p className="hint">Match length: {matchDuration===60?'1 minute':`${matchDuration} seconds`}. Your roller moves continuously. Hold the left/right arrows or A/D to steer. {!solo&&'Trails are shared live with everyone in the room.'}</p><div className="steering"><button aria-label="Steer left" onPointerDown={()=>steer(-1)} onPointerUp={()=>steer(0)} onPointerLeave={()=>steer(0)}>←</button><span>STEER</span><button aria-label="Steer right" onPointerDown={()=>steer(1)} onPointerUp={()=>steer(0)} onPointerLeave={()=>steer(0)}>→</button></div><button className="leave-btn" onClick={()=>onLeave(peers.length>0)}>LEAVE ROOM</button>
    </aside><div className="board-wrap"><div className="board-head"><span>● &nbsp;ROLLER ARENA <small>· LIVE PAINT SYNC</small></span><span>ROUND 01</span></div><div className="arena-frame"><canvas ref={canvasRef} width={arenaSize} height={arenaSize} className="arena-canvas" aria-label="Multiplayer paint arena. Rollers move automatically and players steer with left/right arrows or A/D."/></div><div className="board-foot"><span>↖ ROLL TO PAINT</span><span>CLAIM THE FLOOR TO WIN ↗</span></div></div></section><footer className="footer"><span>LEFT / RIGHT ARROWS OR A / D TO STEER</span><span>MOST OF THE FLOOR WINS</span></footer></main>
}
