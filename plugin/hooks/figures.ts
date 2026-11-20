// Pixel figures for the top of the pane: Pigment's own little block characters,
// one per view. Drawn as an SVG of squares on desktop and half-block cells in the terminal.

/** One letter per pixel; '.' is empty. 18 × 14. */
const MANAGER = [
  '......LLLLLL......',
  '......HHHHHH......',
  '......GGGGGG......',
  '...HHHHHHHHHHHH...',
  '....OOOOOOOOOO....',
  '....OOOOOOOOOO....',
  '....OOOOOOBBBO....',
  '..OOOOKKOOBKBOOO..',
  '..OOOOOOOOBBBOOO..',
  '....OOOOOOOOOB....',
  '....OOOOOOOOOOB...',
  '....DDDDDDDDDD.B..',
  '.....O.O..O.O.....',
  '.....O.O..O.O.....',
]

const DEVELOPER = [
  '..................',
  '..................',
  '..................',
  '..................',
  '....OOOOOOOOOO....',
  '....OOOOOOOOOO....',
  '....OOKOOOOKOO....',
  '..OOOOKOOOOKOOOO..',
  '..OOSSSSSSSSSSOO..',
  '....WWWWWWWWWW....',
  '....WWWWSSWWWW....',
  '....WWWWWWWWWW....',
  '...SSSSSSSSSSSS...',
  '.....O.O..O.O.....',
]

const COLORS: Record<string, number> = {
  O: 0xd97757, // body
  D: 0xb5603f, // body, shade
  K: 0x1a1a18, // eyes
  H: 0x3b3936, // hat (dark, still visible on a dark theme)
  L: 0x5a5651, // hat, top edge
  G: 0x8b7d6b, // hat band
  B: 0x5b7fd4, // magnifying glass
  W: 0xf2f0ea, // laptop
  S: 0xa8a29a, // laptop edge
}

export type FigureName = 'manager' | 'developer'

function grid(name: FigureName): string[] {
  return name === 'manager' ? MANAGER : DEVELOPER
}

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')

/** Square pixels as an SVG, `scale` CSS pixels each. */
export function figureSvg(name: FigureName, scale = 4): string {
  const g = grid(name)
  const w = g[0]!.length
  const h = g.length
  const rects: string[] = []
  g.forEach((row, y) => [...row].forEach((ch, x) => {
    const c = COLORS[ch]
    if (c !== undefined) rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${hex(c)}"/>`)
  }))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" shape-rendering="crispEdges">${rects.join('')}</svg>`
}

const DEFAULT = 0x01000000 // the terminal's own color
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄

/** Two pixels per terminal cell (top and bottom halves), for a Raster. */
export function figureCells(name: FigureName): { columns: number; rows: number; cells: string } {
  const g = grid(name)
  const columns = g[0]!.length
  const rows = Math.ceil(g.length / 2)
  const words: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < columns; x++) {
      const top = COLORS[g[2 * r]?.[x] ?? '.']
      const bottom = COLORS[g[2 * r + 1]?.[x] ?? '.']
      if (top === undefined && bottom === undefined) words.push(0x20, DEFAULT, DEFAULT)
      else if (top === undefined) words.push(LOWER, bottom!, DEFAULT)
      else words.push(UPPER, top, bottom ?? DEFAULT)
    }
  }
  const bytes = new Uint8Array(new Uint32Array(words).buffer)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return { columns, rows, cells: btoa(bin) }
}
