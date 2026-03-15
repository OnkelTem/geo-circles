import { useEffect, useRef, useState } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { EdgeClampedProgram, drawDiscNodeLabel } from 'sigma/rendering'
import { createNodeImageProgram } from '@sigma/node-image'

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
}

type LabelContext = Parameters<typeof drawDiscNodeLabel>

function drawNodeOutline(context: CanvasRenderingContext2D, data: LabelContext[1]) {
  context.save()
  context.strokeStyle = '#cbd5e1'
  context.lineWidth = 1
  context.beginPath()
  context.arc(data.x, data.y, data.size, 0, Math.PI * 2)
  context.stroke()
  context.restore()
}

function drawSmartLabel(context: CanvasRenderingContext2D, data: LabelContext[1], settings: LabelContext[2]) {
  if (!data.label) return

  const fontSize = settings.labelSize ?? 11
  context.font = `${settings.labelWeight ?? 'normal'} ${fontSize}px ${settings.labelFont ?? 'sans-serif'}`
  const textWidth = context.measureText(data.label).width

  if (textWidth <= data.size * 2 * 0.82) {
    context.save()
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.lineWidth = 3
    context.lineJoin = 'round'
    context.strokeStyle = 'rgba(255,255,255,0.7)'
    context.strokeText(data.label, data.x, data.y)
    context.fillStyle = '#1e293b'
    context.fillText(data.label, data.x, data.y)
    context.restore()
  } else {
    drawDiscNodeLabel(context, data, settings)
  }
}

const NodeImageProgram = createNodeImageProgram({
  keepWithinCircle: true,
  drawLabel: (context, data, settings) => {
    drawNodeOutline(context, data)
    drawSmartLabel(context, data, settings)
  },
  // drawHover only draws the glow ring around the circle.
  // Text is handled by drawLabel on the labels canvas, which we raise
  // above hoverNodes WebGL via CSS z-index after sigma initialises.
  drawHover: (context, data) => {
    const PADDING = 2
    context.save()
    context.fillStyle = '#fff'
    context.shadowOffsetX = 0
    context.shadowOffsetY = 0
    context.shadowBlur = 8
    context.shadowColor = '#000'
    context.beginPath()
    context.arc(data.x, data.y, data.size + PADDING, 0, Math.PI * 2)
    context.closePath()
    context.fill()
    context.restore()
  },
})

interface BorderLink {
  source: string
  target: string
}

interface BorderData {
  nodes: CountryNode[]
  links: BorderLink[]
}

// radius = sqrt(area / 4) * K_SCALE  — proportional to real area
const SHOW_FLAGS = false  // set to false to fill nodes with color only
const K_SCALE = 0.04
const STORAGE_KEY = 'bordergraph-positions'

function loadSavedPositions(): Record<string, { x: number; y: number }> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function savePositions(graph: Graph) {
  const positions: Record<string, { x: number; y: number }> = {}
  graph.forEachNode((node, attrs) => {
    positions[node] = { x: attrs.x as number, y: attrs.y as number }
  })
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(positions)) } catch { /* quota */ }
}

function nodeSize(area: number): number {
  return Math.sqrt(Math.max(area, 1) / 4) * K_SCALE
}

export default function BorderGraph() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!containerRef.current) return
    let sigma: Sigma | null = null

    const fetchJSON = <T,>(url: string) =>
      fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`); return r.json() as Promise<T> })

    const requests: [Promise<BorderData>, Promise<Record<string, string>>] = [
      fetchJSON<BorderData>('/data/countries.json'),
      SHOW_FLAGS
        ? fetchJSON<Record<string, string>>('/data/flags.json')
        : Promise.resolve({} as Record<string, string>),
    ]

    Promise.all(requests)
      .then(([data, flags]) => {
        const graph = new Graph({ multi: false })
        const savedPositions = loadSavedPositions()

        data.nodes.forEach(n => {
          const saved = savedPositions?.[n.id]
          graph.addNode(n.id, {
            label: n.name,
            size:  nodeSize(n.area),
            color: n.color,
            x: saved ? saved.x : n.lng,
            y: saved ? saved.y : n.lat,
            ...(SHOW_FLAGS && flags[n.isoA3] ? { type: 'image', image: flags[n.isoA3] } : {}),
          })
        })

        data.links.forEach(l => {
          if (graph.hasNode(l.source) && graph.hasNode(l.target) &&
              !graph.hasEdge(l.source, l.target)) {
            graph.addEdge(l.source, l.target)
          }
        })

        sigma = new Sigma(graph, containerRef.current!, {
          minCameraRatio: 0.05,
          maxCameraRatio: 10,
          defaultEdgeColor: '#94a3b8',
          defaultEdgeType: 'clamped',
          edgeProgramClasses: { clamped: EdgeClampedProgram },
          defaultNodeType: 'image',
          nodeProgramClasses: { image: NodeImageProgram },
          labelFont: 'Inter, system-ui, sans-serif',
          labelSize: 11,
          labelColor: { color: '#1e293b' },
          labelRenderedSizeThreshold: 0,
        })

        // Raise labels canvas above hoverNodes WebGL so that drawLabel text
        // (including inside-circle labels) is always visible during hover.
        const si = sigma as unknown as {
          canvasContexts: Record<string, CanvasRenderingContext2D>
          webGLContexts: Record<string, WebGLRenderingContext>
        }
        const labelsCanvas   = si.canvasContexts.labels.canvas as HTMLCanvasElement
        const hoverNodesCanvas = si.webGLContexts.hoverNodes.canvas as HTMLCanvasElement
        const mouseCanvas    = si.canvasContexts.mouse.canvas  as HTMLCanvasElement
        labelsCanvas.style.zIndex      = '10'
        labelsCanvas.style.pointerEvents = 'none'
        hoverNodesCanvas.style.zIndex  = '9'
        mouseCanvas.style.zIndex       = '20'

        // --- Drag & drop ---
        let draggedNode: string | null = null

        sigma.on('downNode', ({ node }) => {
          draggedNode = node
          sigma!.getCamera().disable()
        })

        sigma.getMouseCaptor().on('mousemove', (e) => {
          if (!draggedNode || !sigma) return
          const pos = sigma.viewportToGraph({ x: e.x, y: e.y })
          graph.setNodeAttribute(draggedNode, 'x', pos.x)
          graph.setNodeAttribute(draggedNode, 'y', pos.y)
        })

        sigma.getMouseCaptor().on('mouseup', () => {
          draggedNode = null
          sigma?.getCamera().enable()
          savePositions(graph)
        })

        sigma.on('enterNode', ({ node }) => {
          if (containerRef.current) containerRef.current.style.cursor = 'grab'
          // Force drawLabel to run for this node even if culled by label grid
          graph.setNodeAttribute(node, 'forceLabel', true)
          sigma!.refresh()
        })
        sigma.on('leaveNode', ({ node }) => {
          if (containerRef.current) containerRef.current.style.cursor = ''
          graph.removeNodeAttribute(node, 'forceLabel')
          sigma!.refresh()
        })

        setLoading(false)
      })
      .catch(e => {
        setError(String(e))
        setLoading(false)
      })

    return () => { sigma?.kill() }
  }, [])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100dvh', background: '#f8fafc' }}>
      {/* Graph canvas */}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Title */}
      <div style={{
        position: 'absolute', top: 16, left: 16,
        color: '#0f172a', fontFamily: 'Inter, system-ui, sans-serif',
      }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Country Borders</h1>
        <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>
          node size ∝ area
        </p>
      </div>

      {/* Reset layout button */}
      <button
        onClick={() => { localStorage.removeItem(STORAGE_KEY); location.reload() }}
        style={{
          position: 'absolute', top: 16, right: 16, zIndex: 30,
          padding: '6px 12px', fontSize: 12, cursor: 'pointer',
          background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6,
          color: '#475569', fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        Reset layout
      </button>

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: 16, left: 16,
        display: 'flex', flexDirection: 'column', gap: 6,
        fontFamily: 'Inter, system-ui, sans-serif',
      }}>
        <span style={{ color: '#64748b', fontSize: 11 }}>each color = one country</span>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: '#64748b', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 14,
        }}>
          Loading…
        </div>
      )}
      {error && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: '#f87171', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 14,
        }}>
          {error}
        </div>
      )}
    </div>
  )
}
