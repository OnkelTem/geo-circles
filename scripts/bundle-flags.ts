#!/usr/bin/env tsx
/**
 * Reads all SVG files from public/flags/{isoA3}.svg, minifies them,
 * base64-encodes them, and writes a single public/data/flags.json:
 * { "RUS": "data:image/svg+xml;base64,...", ... }
 *
 * One HTTP request instead of hundreds of individual flag fetches.
 *
 * Usage:  npm run bundle-flags
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'

const FLAGS_DIR = 'public/flags'
const OUT_FILE = 'public/data/flags.json'

function minifySvg(svg: string): string {
  return svg
    .replace(/<\?xml[^?]*\?>/g, '')        // remove XML declaration
    .replace(/<!--[\s\S]*?-->/g, '')        // remove comments
    .replace(/>\s+</g, '><')               // collapse whitespace between tags
    .replace(/[ \t]*\n[ \t]*/g, '')        // remove newlines with surrounding whitespace
    .replace(/  +/g, ' ')                  // collapse multiple spaces
    .trim()
}

function main() {
  const files = readdirSync(FLAGS_DIR).filter(f => f.endsWith('.svg'))
  console.log(`Bundling ${files.length} flag SVGs into ${OUT_FILE}…`)

  const result: Record<string, string> = {}
  let totalOriginal = 0
  let totalMinified = 0

  for (const file of files) {
    const isoA3 = basename(file, '.svg')
    const svgRaw = readFileSync(join(FLAGS_DIR, file), 'utf8')
    const svgMin = minifySvg(svgRaw)
    const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svgMin).toString('base64')
    result[isoA3] = dataUri
    totalOriginal += svgRaw.length
    totalMinified += svgMin.length
  }

  writeFileSync(OUT_FILE, JSON.stringify(result))
  const outSize = statSync(OUT_FILE).size

  console.log(`Done: ${files.length} flags`)
  console.log(`  SVG original total: ${(totalOriginal / 1024).toFixed(0)} KB`)
  console.log(`  SVG minified total: ${(totalMinified / 1024).toFixed(0)} KB`)
  console.log(`  Output JSON:        ${(outSize / 1024).toFixed(0)} KB (+ gzip in prod)`)
}

main()
