import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CountryNode {
  id: string
  isoA3: string
  iso2?: string
  name: string
  area: number
  population: number
  continent: string
  lat: number
  lng: number
  color: string
  // runtime layout position
  x: number
  y: number
  r: number
}

interface BorderLink {
  source: string
  target: string
}

interface BorderData {
  nodes: CountryNode[]
  links: BorderLink[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

// In D3 canvas, radius is in graph-space degrees and scales with zoom.
// The world fits in ~360° wide; at initial fit k≈3.4 px/°.
// Target: Russia (~82 geo-units in Sigma) → ~0.04/3.4 ≈ 0.012 here.
const K_SCALE     = 0.010
const STORAGE_KEY = 'bordergraph-positions'
const FONT        = 'Inter, system-ui, sans-serif'
const LABEL_SIZE  = 11
const COLLISION_DEFAULT    = true
const COLLISION_KEY        = 'bordergraph-collision'
const LEAF_THRESHOLD_DEFAULT = 200  // km²
const HIDE_SMALL_LEAFS_DEFAULT = true

function nodeRadius(area: number): number {
  return Math.sqrt(Math.max(area, 1) / 4) * K_SCALE
}

// ─── localStorage ─────────────────────────────────────────────────────────────

function loadPositions(): Record<string, { x: number; y: number }> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BorderGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError]     = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showDetails, setShowDetails] = useState(false)
  const showDetailsRef = useRef(false)
  const collisionInit = (() => {
    try { const v = localStorage.getItem(COLLISION_KEY); return v === null ? COLLISION_DEFAULT : v === 'true' } catch { return COLLISION_DEFAULT }
  })()
  const [collisionEnabled, setCollisionEnabled] = useState(collisionInit)
  const collisionEnabledRef = useRef(collisionInit)
  const [hideLeaves, setHideLeaves] = useState(HIDE_SMALL_LEAFS_DEFAULT)
  const hideLeavesRef = useRef(HIDE_SMALL_LEAFS_DEFAULT)
  const [leafThreshold, setLeafThreshold] = useState(LEAF_THRESHOLD_DEFAULT)
  const leafThresholdRef = useRef(LEAF_THRESHOLD_DEFAULT)
  const [leafCount, setLeafCount] = useState(0)
  const leafSetRef = useRef(new Set<string>())

  useEffect(() => {
    if (!canvasRef.current) return
    const canvas: HTMLCanvasElement = canvasRef.current
    const ctx = canvas.getContext('2d')!

    let W = 0, H = 0
    const ro = new ResizeObserver(entries => {
      const e = entries[0]
      W = e.contentRect.width
      H = e.contentRect.height
      canvas.width  = W * devicePixelRatio
      canvas.height = H * devicePixelRatio
      canvas.style.width  = W + 'px'
      canvas.style.height = H + 'px'
      draw()
    })
    ro.observe(canvas)

    let transform = d3.zoomIdentity
    let nodes: CountryNode[] = []
    let links: Array<{ source: CountryNode; target: CountryNode }> = []
    let hoveredNode: CountryNode | null = null
    let dragNode: CountryNode | null = null
    let dragMoved = false
    const dirtyIds = new Set<string>()  // nodes displaced by collision during this drag

    const COLL_PADDING  = 0.5   // minimum gap between circle edges (graph units = degrees)
    const COLL_ITERS    = 3     // separation passes per pointer-move frame (keep low for 60fps)
    const LAYOUT_ITERS  = 300   // passes for initial static layout

    // During drag we only check nodes within this graph-unit radius of the pinned node.
    // Anything farther cannot possibly overlap after a single move event.
    const DRAG_CHECK_RADIUS = 30  // degrees — covers all realistic neighbours

    function resolveCollisions(pinned?: CountryNode, maxIter = COLL_ITERS) {
      for (let iter = 0; iter < maxIter; iter++) {
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i]
          // During drag: skip nodes that are too far from the pinned node to matter
          if (pinned && a.id !== pinned.id) {
            const ddx = a.x - pinned.x, ddy = a.y - pinned.y
            if (ddx * ddx + ddy * ddy > DRAG_CHECK_RADIUS * DRAG_CHECK_RADIUS) continue
          }
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j]
            if (pinned && b.id !== pinned.id) {
              const ddx = b.x - pinned.x, ddy = b.y - pinned.y
              if (ddx * ddx + ddy * ddy > DRAG_CHECK_RADIUS * DRAG_CHECK_RADIUS) continue
            }
            const dx = b.x - a.x, dy = b.y - a.y
            const dist2 = dx * dx + dy * dy
            const minDist = a.r + b.r + COLL_PADDING
            if (dist2 >= minDist * minDist) continue
            const dist = dist2 > 0 ? Math.sqrt(dist2) : 1e-9
            const overlap = minDist - dist
            const nx = dx / dist, ny = dy / dist
            const aPinned = pinned && a.id === pinned.id
            const bPinned = pinned && b.id === pinned.id
            if (!aPinned) {
              a.x -= nx * (bPinned ? overlap : overlap * 0.5)
              a.y -= ny * (bPinned ? overlap : overlap * 0.5)
              if (pinned) dirtyIds.add(a.id)
            }
            if (!bPinned) {
              b.x += nx * (aPinned ? overlap : overlap * 0.5)
              b.y += ny * (aPinned ? overlap : overlap * 0.5)
              if (pinned) dirtyIds.add(b.id)
            }
          }
        }
      }
    }

    function computeLeafSet() {
      const degree = new Map<string, number>()
      for (const n of nodes) degree.set(n.id, 0)
      for (const l of links) {
        degree.set(l.source.id, (degree.get(l.source.id) ?? 0) + 1)
        degree.set(l.target.id, (degree.get(l.target.id) ?? 0) + 1)
      }
      const thresh = leafThresholdRef.current
      const s = new Set<string>()
      for (const n of nodes) {
        if ((degree.get(n.id) ?? 0) === 1 && n.area < thresh) s.add(n.id)
      }
      leafSetRef.current = s
      setLeafCount(s.size)
    }

    function toScreen(gx: number, gy: number): [number, number] {
      return [
        transform.applyX(gx) * devicePixelRatio,
        transform.applyY(-gy) * devicePixelRatio,  // negate lat: canvas y goes down, lat goes up
      ]
    }

    function screenR(r: number): number {
      return r * transform.k * devicePixelRatio
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (!nodes.length) return

      // ── Edges ──────────────────────────────────────────────────────────────
      // Draw center-to-center; circles (drawn after) paint over the inner portions.
      // This way edges are always visible where there is a gap between circles.
      const hiddenNodes = hideLeavesRef.current ? leafSetRef.current : null
      ctx.save()
      ctx.globalAlpha = 0.85
      ctx.strokeStyle = '#64748b'
      ctx.lineWidth   = devicePixelRatio * 0.6
      for (const l of links) {
        if (hiddenNodes && (hiddenNodes.has(l.source.id) || hiddenNodes.has(l.target.id))) continue
        const [sx, sy] = toScreen(l.source.x, l.source.y)
        const [tx, ty] = toScreen(l.target.x, l.target.y)
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.lineTo(tx, ty)
        ctx.stroke()
      }
      ctx.restore()

      // ── Circles (largest first so small ones render on top) ────────────────
      const sorted = [...nodes].sort((a, b) => b.r - a.r)
      for (const n of sorted) {
        if (hiddenNodes?.has(n.id)) continue
        const [cx, cy] = toScreen(n.x, n.y)
        const cr = screenR(n.r)
        ctx.beginPath()
        ctx.arc(cx, cy, cr, 0, Math.PI * 2)
        ctx.fillStyle = n.color
        ctx.fill()
        ctx.strokeStyle = '#cbd5e1'
        ctx.lineWidth   = devicePixelRatio
        ctx.stroke()
      }

      // ── Hover ring ─────────────────────────────────────────────────────────
      if (hoveredNode) {
        const [cx, cy] = toScreen(hoveredNode.x, hoveredNode.y)
        const cr = screenR(hoveredNode.r)
        ctx.save()
        ctx.beginPath()
        ctx.arc(cx, cy, cr + 2 * devicePixelRatio, 0, Math.PI * 2)
        ctx.strokeStyle = '#1e293b'
        ctx.lineWidth   = 2 * devicePixelRatio
        ctx.shadowBlur  = 8 * devicePixelRatio
        ctx.shadowColor = 'rgba(0,0,0,0.3)'
        ctx.stroke()
        ctx.restore()
      }

      // ── Labels (on top of everything) ──────────────────────────────────────
      const fontSize = LABEL_SIZE * devicePixelRatio
      ctx.font = `${fontSize}px ${FONT}`
      for (const n of nodes) {
        if (hiddenNodes?.has(n.id)) continue
        const [cx, cy] = toScreen(n.x, n.y)
        const cr = screenR(n.r)
        // Skip only if the circle is truly a sub-pixel dot
        if (cr < 10 * devicePixelRatio) continue
        const label = n.name
        const tw = ctx.measureText(label).width
        if (tw <= cr * 2 * 0.82) {
          // Label fits inside the circle
          ctx.save()
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.lineWidth = 3 * devicePixelRatio; ctx.lineJoin = 'round'
          ctx.strokeStyle = 'rgba(255,255,255,0.7)'
          ctx.strokeText(label, cx, cy)
          ctx.fillStyle = '#1e293b'
          ctx.fillText(label, cx, cy)
          if (showDetailsRef.current) {
            const diamKm = (n.r * 2 * 111.32).toFixed(0)  // 1° ≈ 111.32 km
            const areaStr = n.area >= 1e6
              ? `${(n.area / 1e6).toFixed(2)}M km²`
              : `${Math.round(n.area).toLocaleString()} km²`
            const line1 = n.id
            const line2 = areaStr
            const line3 = `ø ${diamKm} km`
            const smallFont = `${fontSize * 0.75}px ${FONT}`
            ctx.font = smallFont
            ctx.strokeStyle = 'rgba(255,255,255,0.7)'
            ctx.fillStyle = '#475569'
            let dy = cy + fontSize * 0.85
            for (const line of [line1, line2, line3]) {
              ctx.strokeText(line, cx, dy)
              ctx.fillText(line, cx, dy)
              dy += fontSize * 0.85
            }
            ctx.font = `${fontSize}px ${FONT}`
          }
          ctx.restore()
        } else {
          // Label below the circle — always shown when circle is visible
          const ly = cy + cr + fontSize * 0.75
          ctx.save()
          ctx.textAlign = 'center'; ctx.textBaseline = 'top'
          ctx.lineWidth = 3 * devicePixelRatio; ctx.lineJoin = 'round'
          ctx.strokeStyle = 'rgba(255,255,255,0.85)'
          ctx.strokeText(label, cx, ly)
          ctx.fillStyle = '#1e293b'
          ctx.fillText(label, cx, ly)
          if (showDetailsRef.current) {
            const diamKm = (n.r * 2 * 111.32).toFixed(0)
            const areaStr = n.area >= 1e6
              ? `${(n.area / 1e6).toFixed(2)}M km²`
              : `${Math.round(n.area).toLocaleString()} km²`
            const smallFont = `${fontSize * 0.75}px ${FONT}`
            ctx.font = smallFont
            ctx.strokeStyle = 'rgba(255,255,255,0.85)'
            ctx.fillStyle = '#64748b'
            let dly = ly + fontSize * 1.0
            for (const line of [n.id, areaStr, `ø ${diamKm} km`]) {
              ctx.strokeText(line, cx, dly)
              ctx.fillText(line, cx, dly)
              dly += fontSize * 0.85
            }
            ctx.font = `${fontSize}px ${FONT}`
          }
          ctx.restore()
        }
      }
    }

    function nodeAt(sx: number, sy: number): CountryNode | null {
      // smallest radius checked first → small nodes win over large ones beneath
      const sorted = [...nodes].sort((a, b) => a.r - b.r)
      for (const n of sorted) {
        const [cx, cy] = toScreen(n.x, n.y)
        const cr = screenR(n.r)
        const dx = sx * devicePixelRatio - cx
        const dy = sy * devicePixelRatio - cy
        if (dx * dx + dy * dy <= cr * cr) return n
      }
      return null
    }

    // ── D3 zoom ────────────────────────────────────────────────────────────────
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.02, 2000])
      .filter(event => {
        if (dragNode) return false
        if (event.type === 'wheel') return true
        return !nodeAt(event.offsetX, event.offsetY)
      })
      .on('zoom', event => { transform = event.transform; draw() })

    d3.select(canvas).call(zoom)

    // ── Drag ───────────────────────────────────────────────────────────────────
    function onPointerDown(e: PointerEvent) {
      const n = nodeAt(e.offsetX, e.offsetY)
      if (!n) return
      e.stopPropagation()
      dragNode = n
      dragMoved = false
      canvas.setPointerCapture(e.pointerId)
      canvas.style.cursor = 'grabbing'
    }

    function onPointerMove(e: PointerEvent) {
      if (dragNode) {
        dragMoved = true
        const [gx, gy] = transform.invert([e.offsetX, e.offsetY])
        dragNode.x = gx
        dragNode.y = -gy  // invert back: canvas y → lat
        if (collisionEnabledRef.current) resolveCollisions(dragNode)
        draw()
        return
      }
      const n = nodeAt(e.offsetX, e.offsetY)
      if (n !== hoveredNode) {
        hoveredNode = n
        canvas.style.cursor = n ? 'grab' : ''
        draw()
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (!dragNode) return
      canvas.releasePointerCapture(e.pointerId)
      if (dragMoved) {
        // Persist the dragged node + any nodes displaced by collision
        dirtyIds.add(dragNode.id)
        const existing = loadPositions() ?? {}
        for (const id of dirtyIds) {
          const n = nodes.find(nd => nd.id === id)
          if (n) existing[id] = { x: n.x, y: n.y }
        }
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(existing)) } catch { /* quota */ }
        dirtyIds.clear()
      }
      dragNode = null
      dragMoved = false
      canvas.style.cursor = ''
      draw()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup',   onPointerUp)
    const onRedraw = () => draw()
    canvas.addEventListener('redraw', onRedraw)
    const onRunCollision = () => { resolveCollisions(undefined, LAYOUT_ITERS); draw() }
    canvas.addEventListener('run-collision', onRunCollision)
    const onThresholdChange = (e: Event) => {
      leafThresholdRef.current = (e as CustomEvent<number>).detail
      computeLeafSet()
      draw()
    }
    canvas.addEventListener('threshold-change', onThresholdChange as EventListener)

    // ── Fetch ──────────────────────────────────────────────────────────────────
    fetch('/data/countries.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<BorderData> })
      .then(data => {
        const saved = loadPositions()
        const nodeMap = new Map<string, CountryNode>()

        nodes = data.nodes.map(raw => {
          const pos = saved?.[raw.id]
          const n: CountryNode = { ...raw, x: pos ? pos.x : raw.lng, y: pos ? pos.y : raw.lat, r: nodeRadius(raw.area) }
          nodeMap.set(raw.id, n)
          return n
        })

        links = data.links
          .filter(l => nodeMap.has(l.source) && nodeMap.has(l.target))
          .map(l => ({ source: nodeMap.get(l.source)!, target: nodeMap.get(l.target)! }))

        computeLeafSet()

        // Initial static layout: separate all overlapping circles.
        // Nodes that were manually saved keep their position as a soft anchor —
        // they still participate in collision but are not pinned.
        if (collisionEnabledRef.current) resolveCollisions(undefined, LAYOUT_ITERS)

        // Always fit all nodes into view — camera needs a valid transform regardless
        // of whether some positions were saved. Without this, saved-but-no-fit
        // renders everything at raw degree values (scale=1) → top-left cluster.
        if (W && H) {
          const xs = nodes.map(n => n.x), ys = nodes.map(n => -n.y)
          const x0 = Math.min(...xs), x1 = Math.max(...xs)
          const y0 = Math.min(...ys), y1 = Math.max(...ys)
          const pad = 10
          const k = Math.min(W / (x1 - x0 + pad * 2), H / (y1 - y0 + pad * 2))
          const tx = W / 2 - k * (x0 + x1) / 2
          const ty = H / 2 - k * (y0 + y1) / 2
          transform = d3.zoomIdentity.translate(tx, ty).scale(k)
          d3.select(canvas).call(zoom.transform, transform)
        }

        setLoading(false)
        draw()
      })
      .catch(e => { setError(String(e)); setLoading(false) })

    return () => {
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup',   onPointerUp)
      canvas.removeEventListener('redraw', onRedraw)
      canvas.removeEventListener('run-collision', onRunCollision)
      canvas.removeEventListener('threshold-change', onThresholdChange as EventListener)
    }
  }, [])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100dvh', background: '#f8fafc' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

      <div style={{
        position: 'absolute', top: 16, left: 16, pointerEvents: 'none',
        color: '#0f172a', fontFamily: FONT,
      }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Country Borders</h1>
        <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>node size ∝ area</p>
      </div>

      <button
        onClick={() => { localStorage.removeItem(STORAGE_KEY); location.reload() }}
        style={{
          position: 'absolute', top: 16, right: 16, zIndex: 10,
          padding: '6px 12px', fontSize: 12, cursor: 'pointer',
          background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6,
          color: '#475569', fontFamily: FONT,
        }}
      >
        Reset layout
      </button>

      <button
        onClick={() => {
          const next = !showDetails
          setShowDetails(next)
          showDetailsRef.current = next
          canvasRef.current?.dispatchEvent(new Event('redraw'))
        }}
        style={{
          position: 'absolute', top: 16, right: 130, zIndex: 10,
          padding: '6px 12px', fontSize: 12, cursor: 'pointer',
          background: showDetails ? '#1e293b' : '#fff',
          border: '1px solid #cbd5e1', borderRadius: 6,
          color: showDetails ? '#fff' : '#475569', fontFamily: FONT,
        }}
      >
        {showDetails ? 'Hide Details' : 'Show Details'}
      </button>

      <button
        onClick={() => {
          const next = !collisionEnabled
          setCollisionEnabled(next)
          collisionEnabledRef.current = next
          try { localStorage.setItem(COLLISION_KEY, String(next)) } catch { /* quota */ }
          if (next) canvasRef.current?.dispatchEvent(new Event('run-collision'))
        }}
        style={{
          position: 'absolute', top: 16, right: 260, zIndex: 10,
          padding: '6px 12px', fontSize: 12, cursor: 'pointer',
          background: collisionEnabled ? '#1e293b' : '#fff',
          border: '1px solid #cbd5e1', borderRadius: 6,
          color: collisionEnabled ? '#fff' : '#475569', fontFamily: FONT,
        }}
      >
        {collisionEnabled ? 'Collision: ON' : 'Collision: OFF'}
      </button>

      <div style={{
        position: 'absolute', top: 52, right: 16, zIndex: 10,
        background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6,
        padding: '8px 12px', fontFamily: FONT, fontSize: 12, color: '#475569',
        display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={hideLeaves}
              onChange={e => {
                const next = e.target.checked
                setHideLeaves(next)
                hideLeavesRef.current = next
                canvasRef.current?.dispatchEvent(new Event('redraw'))
              }}
            />
            Hide small leaves
          </label>
          <span style={{ color: '#94a3b8' }}>{leafCount} territories</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ whiteSpace: 'nowrap' }}>Threshold:</span>
          <input
            type="range"
            min={1} max={500} step={1}
            value={leafThreshold}
            style={{ flex: 1 }}
            onChange={e => {
              const val = Number(e.target.value)
              setLeafThreshold(val)
              leafThresholdRef.current = val
              canvasRef.current?.dispatchEvent(new CustomEvent('threshold-change', { detail: val }))
            }}
          />
          <span style={{ whiteSpace: 'nowrap', minWidth: 70, textAlign: 'right' }}>
            {leafThreshold} km²
          </span>
        </div>
      </div>

      {loading && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: '#64748b', fontFamily: FONT, fontSize: 14, pointerEvents: 'none',
        }}>Loading…</div>
      )}
      {error && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: '#f87171', fontFamily: FONT, fontSize: 14, pointerEvents: 'none',
        }}>{error}</div>
      )}
    </div>
  )
}
