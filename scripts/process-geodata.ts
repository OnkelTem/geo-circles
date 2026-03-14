#!/usr/bin/env tsx
/**
 * Downloads Natural Earth 10m countries GeoJSON, explodes MultiPolygon features
 * into individual Polygon nodes, computes spatial adjacency (shared borders),
 * and writes public/data/countries.json.
 *
 * Usage:  npx tsx scripts/process-geodata.ts
 */

import { writeFileSync, mkdirSync } from 'fs'
import * as turf from '@turf/turf'
import type { Feature, Polygon, MultiPolygon, BBox, FeatureCollection } from 'geojson'

const NATURAL_EARTH_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson'

const OUT_FILE = 'public/data/countries.json'

// ─── Types ───────────────────────────────────────────────────────────────────

interface NodeData {
  id: string         // "RUS_0", "RUS_1" — suffix only if MultiPolygon
  isoA3: string
  iso2?: string      // ISO 3166-1 alpha-2, lowercase, e.g. "ru"
  name: string
  continent: string
  area: number       // km²
  population: number
  lat: number        // centroid
  lng: number        // centroid
  color: string      // hex, derived from isoA3 via golden-angle hue
}

interface LinkData {
  source: string
  target: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bboxOverlap(b1: BBox, b2: BBox, pad = 0.05): boolean {
  return (
    b1[0] - pad <= b2[2] &&
    b1[2] + pad >= b2[0] &&
    b1[1] - pad <= b2[3] &&
    b1[3] + pad >= b2[1]
  )
}

/** Golden-angle palette: assigns maximally distinct hues to an ordered set of keys. */
function buildColorPalette(isoList: string[]): Map<string, string> {
  const sorted = [...isoList].sort()
  const GOLDEN_ANGLE = 137.508
  const palette = new Map<string, string>()
  sorted.forEach((iso, idx) => {
    const hue = (idx * GOLDEN_ANGLE) % 360
    const sat = 55 + (idx % 3) * 7   // 55 / 62 / 69 — slight variation
    const lit = 48 + (idx % 2) * 6   // 48 / 54 — avoid too dark or washed out
    palette.set(iso, hslToHex(hue, sat, lit))
  })
  return palette
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
    return Math.round(255 * color).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

// Natural Earth uses ISO_A3 = "-99" for some territories; fall back to NAME_A3
function resolveIso(props: Record<string, unknown>): string {
  const iso = props['ISO_A3'] as string
  if (iso && iso !== '-99') return iso
  return (props['ADM0_A3'] as string) ?? (props['NAME_CIOC'] as string) ?? 'UNK'
}

// ISO 3166-1 alpha-2 from Natural Earth's ISO_A2 field
function resolveIso2(props: Record<string, unknown>): string | undefined {
  const iso2 = props['ISO_A2'] as string
  if (iso2 && iso2 !== '-99') return iso2.toLowerCase()
  return undefined
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Downloading Natural Earth countries GeoJSON…')
  const resp = await fetch(NATURAL_EARTH_URL)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${NATURAL_EARTH_URL}`)
  const geojson = (await resp.json()) as FeatureCollection<Polygon | MultiPolygon>
  console.log(`  Loaded ${geojson.features.length} country features`)

  // ── Explode MultiPolygon → individual Polygon entries ────────────────────
  type PolyEntry = {
    id: string
    iso: string
    feature: Feature<Polygon>
    bbox: BBox
    centroid: [number, number]  // [lng, lat]
    props: Record<string, unknown>
  }

  const polygons: PolyEntry[] = []

  for (const f of geojson.features) {
    const props = f.properties as Record<string, unknown>
    const iso = resolveIso(props)
    const rings: Polygon[] = []

    if (f.geometry.type === 'Polygon') {
      rings.push(f.geometry)
    } else {
      for (const coords of (f.geometry as MultiPolygon).coordinates) {
        rings.push({ type: 'Polygon', coordinates: coords })
      }
    }

    rings.forEach((poly, idx) => {
      // Only append index when country has multiple polygons
      const id = rings.length > 1 ? `${iso}_${idx}` : iso
      const feature = turf.feature(poly) as Feature<Polygon>
      const [lng, lat] = turf.centroid(feature).geometry.coordinates
      polygons.push({
        id,
        iso,
        feature,
        bbox: turf.bbox(feature),
        centroid: [lng, lat],
        props,
      })
    })
  }

  console.log(`  Exploded to ${polygons.length} polygon nodes`)

  // ── Build color palette (golden-angle hue distribution per isoA3) ────────
  const uniqueIsos = [...new Set(polygons.map(p => p.iso))]
  const palette = buildColorPalette(uniqueIsos)

  // ── Build nodes ───────────────────────────────────────────────────────────
  const nodes: NodeData[] = polygons.map(p => ({
    id: p.id,
    isoA3: p.iso,
    iso2: resolveIso2(p.props),
    name: (p.props['ADMIN'] as string) ?? (p.props['NAME'] as string) ?? p.id,
    continent: (p.props['CONTINENT'] as string) ?? '',
    area: turf.area(p.feature) / 1_000_000, // m² → km²
    population: (p.props['POP_EST'] as number) ?? 0,
    lat: p.centroid[1],
    lng: p.centroid[0],
    color: palette.get(p.iso) ?? '#a3a3a3',
  }))

  // ── Compute adjacency ─────────────────────────────────────────────────────
  console.log(`Computing adjacency for ${polygons.length} polygons…`)
  const links: LinkData[] = []
  let candidatePairs = 0

  for (let i = 0; i < polygons.length; i++) {
    if (i % 20 === 0) process.stdout.write(`\r  ${i}/${polygons.length}`)
    for (let j = i + 1; j < polygons.length; j++) {
      // Same country polygons don't form edges
      if (polygons[i].iso === polygons[j].iso) continue
      // Fast bbox pre-filter
      if (!bboxOverlap(polygons[i].bbox, polygons[j].bbox)) continue

      candidatePairs++
      if (turf.booleanIntersects(polygons[i].feature, polygons[j].feature)) {
        links.push({ source: polygons[i].id, target: polygons[j].id })
      }
    }
  }

  console.log(`\n  Checked ${candidatePairs} candidate pairs → ${links.length} borders`)

  // ── Filter: keep only nodes that have at least one border link, or
  //   are the single/largest polygon of their country ──────────────────────
  const linkedIds = new Set(links.flatMap(l => [l.source, l.target]))

  // For each iso, find the largest polygon id
  const largestByIso = new Map<string, string>()
  for (const p of polygons) {
    const current = largestByIso.get(p.iso)
    if (!current) {
      largestByIso.set(p.iso, p.id)
    } else {
      const currentArea = nodes.find(n => n.id === current)!.area
      const thisArea = nodes.find(n => n.id === p.id)!.area
      if (thisArea > currentArea) largestByIso.set(p.iso, p.id)
    }
  }

  const largestIds = new Set(largestByIso.values())
  const keptIds = new Set([...linkedIds, ...largestIds])

  const filteredNodes = nodes.filter(n => keptIds.has(n.id))
  const filteredLinks = links.filter(l => keptIds.has(l.source) && keptIds.has(l.target))

  console.log(`  After filtering: ${filteredNodes.length} nodes, ${filteredLinks.length} links`)
  console.log(`  (removed ${nodes.length - filteredNodes.length} isolated island polygons)`)

  // ── Write output ──────────────────────────────────────────────────────────
  mkdirSync('public/data', { recursive: true })
  writeFileSync(OUT_FILE, JSON.stringify({ nodes: filteredNodes, links: filteredLinks }, null, 2))
  console.log(`Written: ${OUT_FILE}`)
  console.log(`  Nodes: ${filteredNodes.length}, Links: ${filteredLinks.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
