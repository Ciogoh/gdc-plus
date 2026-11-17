/* Glyph Drawing Club+ — rebuild of glyphdrawing.club (MIT, Heikki Lotvonen) with cleaner UI and clean SVG export.
   Cell data format is identical to the original so .gdc files stay compatible:
   layer = [path, svgWidth, svgHeight, baseline, offsetX, sizeMod, rotation, flip, inverted, offsetY, colorIndex]
   cell  = [layer1, layer2, layer3, layer4, [bgColorIndex]]   (bg 255 = none) */
"use strict"

const $ = id => document.getElementById(id)
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const EMPTY_PATH = "M0 0"
const emptyLayer = () => [EMPTY_PATH, 1, 1, 0, 0, 0, 0, 1, false, 0, 0]
// cell = [layer 1 … layer N, [bgColorIndex]]: the background is always the last element
const emptyCell = (n = S.layers) => [...Array.from({ length: n }, emptyLayer), [255]]
const BG = () => S.layers
const range = n => [...Array(n).keys()]
const MAX_LAYERS = 16
const clone = o => JSON.parse(JSON.stringify(o))
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const MAX_HISTORY = 64

/* ---------- state ---------- */
const S = { canvasWidth: 20, canvasHeight: 15, cellWidth: 20, cellHeight: 20, defaultFontSize: 20, layers: 1, canvas: [] }
const U = {
	x: 0, y: 0, layer: 0, hidden: [false, false, false, false],
	sel: { start: null, end: null },
	glyph: { path: EMPTY_PATH, w: 1, h: 1, base: 0, gid: 0 },
	rot: 0, flip: 1, inv: false, offX: 0, offY: 0, sizeMod: 0, offsetAmount: 100,
	paint: false, typing: false, hideGrid: false, mapping: false, offsetHeld: false,
	zoom: 1, panX: 0, panY: 0, fileName: "Untitled", dpi: 150, exportScale: 5,
}
const C = { palettes: [], pal: 0, fg: 0, bg: 255, cohesion: 0, cohColor: [255, 128, 32], editCohesion: false, brushFg: false, brushBg: false, onlyUsed: false }
const K = { sets: [], set: 0 }
let presets = []
let font = null, fontName = ""
let history = [], redoStack = []

/* ---------- persistence (localStorage is per-browser convenience; .gdc files are the real save) ---------- */
const store = {
	get(k) { try { return JSON.parse(localStorage.getItem("gdcplus." + k)) } catch (e) { return null } },
	set(k, v) { try { localStorage.setItem("gdcplus." + k, JSON.stringify(v)) } catch (e) {} },
}
// files keep at least 4 layers so the original glyphdrawing.club can still open them
const fileCanvas = canvas => (S.layers >= 4 ? canvas : canvas.map(r => r.map(c => [...c.slice(0, -1), ...Array.from({ length: 4 - S.layers }, emptyLayer), c[c.length - 1]])))
const getState = () => ({
	name: "gdc-file", timestamp: Math.floor(Date.now() / 1000),
	canvasWidth: S.canvasWidth, canvasHeight: S.canvasHeight, cellWidth: S.cellWidth,
	cellHeight: S.cellHeight, defaultFontSize: S.defaultFontSize, canvas: fileCanvas(S.canvas),
})
const stateKey = () => JSON.stringify([S.canvasWidth, S.canvasHeight, S.cellWidth, S.cellHeight, S.defaultFontSize, S.layers, S.canvas])

/* ---------- validation at the trust boundary (files + localStorage end up in innerHTML) ---------- */
const PATH_OK = /^[MLQCZmlqcz0-9.,\-+eE\s]*$/
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d)
function cleanLayer(L) {
	if (!Array.isArray(L)) return emptyLayer()
	const p = typeof L[0] === "string" && PATH_OK.test(L[0]) && L[0].trim() ? L[0] : EMPTY_PATH
	return [p, num(L[1], 1), num(L[2], 1), num(L[3]), num(L[4]), num(L[5]), num(L[6]), num(L[7], 1) < 0 ? -1 : 1, !!L[8] && L[8] !== "false", num(L[9]), clamp(Math.round(num(L[10])), 0, 255)]
}
const cleanCell = (c, n) => Array.isArray(c) && c.length > 1
	? range(n).map(i => (i < c.length - 1 ? cleanLayer(c[i]) : emptyLayer())).concat([[clamp(Math.round(num(Array.isArray(c[c.length - 1]) ? c[c.length - 1][0] : 255, 255)), 0, 255)]])
	: emptyCell(n)
function cleanState(st) {
	if (!st || !Array.isArray(st.canvas) || !st.canvas.length || !Array.isArray(st.canvas[0])) throw new Error("File non valido")
	const h = st.canvas.length, w = Math.max(...st.canvas.map(r => (Array.isArray(r) ? r.length : 0)))
	if (w < 1 || w * h > 250000) throw new Error("Dimensioni tela non valide")
	const cells = st.canvas.flatMap(r => (Array.isArray(r) ? r : []))
	let n = clamp(Math.max(...cells.map(c => (Array.isArray(c) ? c.length - 1 : 1))), 1, MAX_LAYERS)
	const canvas = st.canvas.map(r => Array.from({ length: w }, (_, x) => cleanCell(Array.isArray(r) ? r[x] : null, n)))
	// drop trailing layers that are empty everywhere (old files always carry 4) — keeps the panel simple
	while (n > 1 && canvas.every(r => r.every(c => isEmpty(c[n - 1])))) { canvas.forEach(r => r.forEach(c => c.splice(n - 1, 1))); n-- }
	return {
		canvasWidth: w, canvasHeight: h, layers: n,
		cellWidth: clamp(num(st.cellWidth, 20), 1, 500), cellHeight: clamp(num(st.cellHeight, 20), 1, 500),
		defaultFontSize: clamp(num(st.defaultFontSize, 20), 1, 500),
		canvas,
	}
}
function setState(st) {
	Object.assign(S, st)
	U.layer = clamp(U.layer, 0, S.layers - 1)
	U.x = clamp(U.x, 0, S.canvasWidth - 1)
	U.y = clamp(U.y, 0, S.canvasHeight - 1)
}

/* ---------- history ---------- */
function commit() {
	const s = stateKey()
	if (history[history.length - 1] === s) return
	history.push(s)
	if (history.length > MAX_HISTORY) history.shift()
	redoStack = []
	saveSoon()
}
function applyKey(s) {
	const [w, h, cw, ch, f, layers, canvas] = JSON.parse(s)
	setState({ canvasWidth: w, canvasHeight: h, cellWidth: cw, cellHeight: ch, defaultFontSize: f, layers, canvas })
}
function undo() {
	if (history.length < 2) return toast("Niente da annullare")
	redoStack.push(history.pop())
	applyKey(history[history.length - 1])
	saveSoon()
}
function redo() {
	if (!redoStack.length) return toast("Niente da ripetere")
	const s = redoStack.pop()
	history.push(s)
	applyKey(s)
	saveSoon()
}
let saveTimer
function saveSoon() {
	clearTimeout(saveTimer)
	saveTimer = setTimeout(() => store.set("state", getState()), 300)
}

/* ---------- colors ---------- */
const colorBlend = (a, b, t) => a.map((v, i) => {
	const o = v < 128 ? (2 * b[i] * v) / 255 : 255 - (2 * (255 - v) * (255 - b[i])) / 255
	return Math.min(Math.round(o * t + v * (1 - t)), 255)
})
const palette = () => C.palettes[C.pal]
const rgbOf = i => `rgb(${colorBlend(palette()[i] || [0, 0, 0], C.cohColor, C.cohesion).join(",")})`
const hexOf = i => "#" + colorBlend(palette()[i] || [0, 0, 0], C.cohColor, C.cohesion).map(v => v.toString(16).padStart(2, "0")).join("")

/* ---------- geometry: the original's nested-svg transform, as one matrix ---------- */
const mul = (m, n) => [
	m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
	m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
	m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
]
const T = (x, y) => [1, 0, 0, 1, x, y]
const Sc = (x, y = x) => [x, 0, 0, y, 0, 0]
const Rot = (deg, cx, cy) => {
	const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r)
	return mul(mul(T(cx, cy), [c, s, -s, c, 0, 0]), T(-cx, -cy))
}
function layerMatrix(L, x, y, F = S.defaultFontSize) {
	const H = L[2] == 1 ? 800 : L[2]
	return [
		T(S.cellWidth * x, S.cellHeight * y), Sc(F / 800),
		T(800 + L[4], 800 + L[9]), Sc((F + L[5]) / F),
		T(L[7] == 1 ? -800 : 0, 0), Sc((L[7] * 800) / H, -800 / H),
		Rot(L[6], H / 2, H / 2), T(0, -L[3]),
	].reduce(mul)
}
const layerPath = L => (L[8] ? `M0 0L0 ${L[2]}L${L[1]} ${L[2]}L${L[1]} 0Z` : "") + L[0]
const r3 = v => Math.round(v * 1000) / 1000
// Typr emits absolute M/L/Q/C/Z only, so every number pair is a point.
// Mirroring, inversion and font flavour all change contour direction; every layer is normalised to a
// positive outer winding so glyphs merged into one compound path fill like the editor (nonzero).
function bakeSubpaths(d, m) {
	const tok = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []
	const subs = []
	let cur = null, seg = null, pend = null
	for (const t of tok) {
		if (/^[MLQCZ]$/i.test(t)) {
			const c = t.toUpperCase()
			if (c === "M") { cur = { start: null, segs: [] }; subs.push(cur); seg = "M" }
			else if (c === "Z") seg = null
			else { seg = { c, pts: [] }; cur.segs.push(seg) }
			continue
		}
		if (pend === null) { pend = +t; continue }
		const p = [r3(m[0] * pend + m[2] * +t + m[4]), r3(m[1] * pend + m[3] * +t + m[5])]
		pend = null
		if (seg === "M") cur.start = p
		else if (seg) seg.pts.push(p)
	}
	const f = p => p[0] + " " + p[1]
	// signed area of the whole layer (outer contour / inverted rect dominates) decides the direction
	const live = subs.filter(s => s.start)
	live.forEach(s => {
		const pts = [s.start, ...s.segs.flatMap(g => g.pts)]
		s.area = 0
		pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; s.area += p[0] * q[1] - q[0] * p[1] })
		const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
		s.box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
	})
	const reverse = live.reduce((t, s) => t + s.area, 0) < 0
	return live.map(s => {
		const area = reverse ? -s.area : s.area
		if (!reverse) return { area, box: s.box, d: "M" + f(s.start) + s.segs.map(g => g.c + g.pts.map(f).join(" ")).join("") + "Z" }
		const ends = [s.start, ...s.segs.map(g => g.pts[g.pts.length - 1])]
		let o = "M" + f(ends[ends.length - 1])
		for (let i = s.segs.length - 1; i >= 0; i--) {
			const g = s.segs[i], ctrl = g.pts.slice(0, -1).reverse()
			o += g.c + [...ctrl, ends[i]].map(f).join(" ")
		}
		return { area, box: s.box, d: o + "Z" }
	})
}
const bakePath = (d, m) => bakeSubpaths(d, m).map(s => s.d).join("")
// split a glyph into separate shapes: each outer contour is its own path, and only real holes
// (opposite winding, inside an outer box) stay attached — so Illustrator gets compound paths only where needed
function bakeShapes(d, m) {
	const subs = bakeSubpaths(d, m), outers = subs.filter(s => s.area >= 0).map(s => ({ ...s, holes: "" }))
	const inside = (a, b) => a.box[0] >= b.box[0] && a.box[1] >= b.box[1] && a.box[2] <= b.box[2] && a.box[3] <= b.box[3]
	const area = s => (s.box[2] - s.box[0]) * (s.box[3] - s.box[1])
	subs.filter(s => s.area < 0).forEach(h => {
		const host = outers.filter(o => inside(h, o)).sort((a, b) => area(a) - area(b))[0]
		if (host) host.holes += h.d
		else outers.push({ ...h, holes: "" })
	})
	return outers.map(o => o.d + o.holes)
}

/* ---------- canvas helpers ---------- */
const cell = (x = U.x, y = U.y) => S.canvas[y][x]
const isEmpty = L => L[0] === EMPTY_PATH
const selectedGlyph = () => [U.glyph.path, U.glyph.w, U.glyph.h, U.glyph.base, U.offX, U.sizeMod, U.rot, U.flip, U.inv, U.offY, C.fg]
function selArea() {
	const { start, end } = U.sel
	if (!start) return null
	const e = end || [U.y, U.x]
	return [[Math.min(start[0], e[0]), Math.min(start[1], e[1])], [Math.max(start[0], e[0]), Math.max(start[1], e[1])]]
}
function eachInArea(area, f) {
	const [[sy, sx], [ey, ex]] = area
	for (let y = sy; y <= ey; y++) for (let x = sx; x <= ex; x++) f(S.canvas[y][x], x, y)
}
// layers an operation touches: selected one, or all four when Ctrl is held
const targetLayers = all => (all ? range(S.layers) : [U.layer])
function forTargets(all, f) {
	const a = selArea()
	if (a) eachInArea(a, c => targetLayers(all).forEach(z => f(c[z], c)))
	else targetLayers(all).forEach(z => f(cell()[z], cell()))
}

/* ---------- actions (mirroring the original CanvasStore) ---------- */
const A = {
	// cursor
	move(dx, dy, alt) {
		if (U.offsetHeld) return A.offset(dx, dy)
		const step = alt ? 5 : 1
		U.x = clamp(U.x + dx * step, 0, S.canvasWidth - 1)
		U.y = clamp(U.y + dy * step, 0, S.canvasHeight - 1)
	},
	// draw
	insert() {
		cell()[U.layer] = selectedGlyph()
		cell()[BG()] = [C.bg]
	},
	erase(all) {
		if (all) S.canvas[U.y][U.x] = emptyCell()
		else cell()[U.layer] = emptyLayer()
	},
	backspace() {
		cell()[U.layer] = emptyLayer()
		if (U.x > 0) U.x--
		else if (U.y > 0) { U.y--; U.x = S.canvasWidth - 1 }
	},
	enter() { U.y = Math.min(U.y + 1, S.canvasHeight - 1); U.x = 0 },
	rotate(all) {
		targetLayers(all).forEach(z => {
			const L = cell()[z]
			L[6] = L[6] <= -270 ? 0 : L[6] - 90
			U.rot = L[6]
		})
	},
	flip(all) { targetLayers(all).forEach(z => { cell()[z][7] *= -1; U.flip = cell()[z][7] }) },
	invert(all) { targetLayers(all).forEach(z => { cell()[z][8] = !cell()[z][8]; U.inv = cell()[z][8] }) },
	copyGlyph() {
		const L = cell()[U.layer]
		if (isEmpty(L)) return toast("Cella vuota")
		U.glyph = { ...U.glyph, path: L[0], w: L[1], h: L[2], base: L[3], gid: null }
		toast("Glyph copiato")
	},
	colorFg(all) { targetLayers(all).forEach(z => (cell()[z][10] = C.fg)) },
	colorBg() { cell()[BG()] = [C.bg] },
	size(d) {
		const L = cell()[U.layer]
		if (L[5] + d < 0) return
		L[5] += d
		U.sizeMod = L[5]
	},
	offset(dx, dy) {
		forTargets(false, L => { L[4] += dx * U.offsetAmount; L[9] += dy * U.offsetAmount })
		U.offX = cell()[U.layer][4]
		U.offY = cell()[U.layer][9]
	},
	glyphReset() {
		Object.assign(U, { sizeMod: 0, inv: false, rot: 0, offX: 0, offY: 0, flip: 1 })
		forTargets(false, L => { L[4] = 0; L[5] = 0; L[6] = 0; L[7] = 1; L[8] = false; L[9] = 0 })
	},
	offsetReset() {
		U.offX = U.offY = 0
		forTargets(false, L => { L[4] = 0; L[9] = 0 })
	},
	selectLayer(d) { U.layer = (U.layer + d + S.layers) % S.layers },
	addLayer() {
		if (S.layers >= MAX_LAYERS) return toast(`Massimo ${MAX_LAYERS} layer`)
		const at = U.layer + 1
		S.canvas.forEach(r => r.forEach(c => c.splice(at, 0, emptyLayer())))
		U.hidden.splice(at, 0, false)
		S.layers++
		U.layer = at
	},
	deleteLayer() {
		if (S.layers < 2) return toast("Serve almeno un layer")
		S.canvas.forEach(r => r.forEach(c => c.splice(U.layer, 1)))
		U.hidden.splice(U.layer, 1)
		S.layers--
		U.layer = Math.max(0, U.layer - 1)
		toast("Layer eliminato — ⌘Z per annullare")
	},
	moveLayer(from, to) {
		if (from === to) return
		S.canvas.forEach(r => r.forEach(c => c.splice(to, 0, c.splice(from, 1)[0])))
		U.hidden.splice(to, 0, U.hidden.splice(from, 1)[0])
		U.layer = to
	},
	// area selection
	makeSelection() {
		if (U.sel.start && !U.sel.end) { const a = selArea(); U.sel = { start: a[0], end: a[1] } }
		else U.sel = { start: [U.y, U.x], end: null }
	},
	deselect() { U.sel = { start: null, end: null } },
	selectAll() { U.sel = { start: [0, 0], end: [S.canvasHeight - 1, S.canvasWidth - 1] } },
	pasteSelection(all) {
		const a = selArea()
		if (!a || !U.sel.end) return toast("Blocca prima la selezione (⇧S)")
		const [[sy, sx], [ey, ex]] = a
		const snap = clone(S.canvas.slice(sy, ey + 1).map(r => r.slice(sx, ex + 1)))
		snap.forEach((row, dy) => row.forEach((c, dx) => {
			const y = U.y + dy, x = U.x + dx
			if (y >= S.canvasHeight || x >= S.canvasWidth) return
			if (all) S.canvas[y][x] = c
			else S.canvas[y][x][U.layer] = c[U.layer]
		}))
	},
	fill(all) {
		const a = selArea(); if (!a) return
		eachInArea(a, c => targetLayers(all).forEach(z => (c[z] = selectedGlyph())))
	},
	clearArea(all) {
		const a = selArea(); if (!a) return
		eachInArea(a, c => { targetLayers(all).forEach(z => (c[z] = emptyLayer())); if (all) c[BG()] = [255] })
	},
	colorFgArea(all) {
		const a = selArea(); if (!a) return
		eachInArea(a, c => targetLayers(all).forEach(z => (c[z][10] = C.fg)))
	},
	fillBgArea(all) {
		const a = selArea(); if (!a) return
		eachInArea(a, c => (c[BG()] = [all ? 255 : C.bg]))
	},
	invertArea(all) {
		const a = selArea(); if (!a) return
		eachInArea(a, c => targetLayers(all).forEach(z => (c[z][8] = !c[z][8])))
	},
	rotateEachArea() { const a = selArea(); a && eachInArea(a, c => (c[U.layer][6] += 90)) },
	flipEachArea() { const a = selArea(); a && eachInArea(a, c => (c[U.layer][7] *= -1)) },
	// rearranging cells; with Ctrl the whole cell (incl. background) moves
	remap(all, mapFn, fixGlyph) {
		const a = selArea(); if (!a) return
		const [[sy, sx], [ey, ex]] = a
		const h = ey - sy + 1, w = ex - sx + 1
		const old = S.canvas.slice(sy, ey + 1).map(r => r.slice(sx, ex + 1).map(c => c.slice()))
		for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
			const [oi, oj] = mapFn(i, j, h, w)
			const src = old[oi][oj], dst = S.canvas[sy + i][sx + j]
			const zs = all ? range(S.layers + 1) : [U.layer]
			zs.forEach(z => (dst[z] = z < S.layers ? clone(src[z]) : src[z].slice()))
			targetLayers(all).forEach(z => fixGlyph && fixGlyph(dst[z]))
		}
	},
	mirrorArea(all) { A.remap(all, (i, j, h, w) => [i, w - 1 - j], L => { L[7] *= -1; L[4] *= -1 }) },
	flipArea(all) { A.remap(all, (i, j, h) => [h - 1 - i, j], L => { L[6] += 180; L[7] *= -1; L[9] *= -1 }) },
	rotateArea(all) {
		const a = selArea(); if (!a) return
		if (a[1][0] - a[0][0] !== a[1][1] - a[0][1]) return toast("La selezione deve essere quadrata")
		A.remap(all, (i, j, h) => [h - 1 - j, i], L => {
			L[6] += L[7] == -1 ? 90 : -90
			if (L[4] || L[9]) [L[4], L[9]] = [-L[9], L[4]]
		})
	},
	transposeArea() {
		const a = selArea(); if (!a) return
		if (a[1][0] - a[0][0] !== a[1][1] - a[0][1]) return toast("La selezione deve essere quadrata")
		A.remap(true, (i, j) => [j, i])
	},
	shiftArea(all, dx, dy) {
		const a = selArea(); if (!a) return
		const [[sy, sx], [ey, ex]] = a
		if (sx + dx < 0 || ex + dx >= S.canvasWidth || sy + dy < 0 || ey + dy >= S.canvasHeight) return
		const snap = clone(S.canvas.slice(sy, ey + 1).map(r => r.slice(sx, ex + 1)))
		eachInArea(a, c => { targetLayers(all).forEach(z => (c[z] = emptyLayer())); if (all) c[BG()] = [255] })
		snap.forEach((row, i) => row.forEach((c, j) => {
			const d = S.canvas[sy + i + dy][sx + j + dx]
			if (all) S.canvas[sy + i + dy][sx + j + dx] = c
			else d[U.layer] = c[U.layer]
		}))
		U.sel = { start: [sy + dy, sx + dx], end: [ey + dy, ex + dx] }
		U.x = clamp(U.x + dx, 0, S.canvasWidth - 1)
		U.y = clamp(U.y + dy, 0, S.canvasHeight - 1)
	},
	// canvas size
	colAdd() { S.canvasWidth++; S.canvas.forEach(r => r.push(emptyCell())) },
	colDel() { if (S.canvasWidth < 2) return; S.canvasWidth--; S.canvas.forEach(r => r.pop()); U.x = Math.min(U.x, S.canvasWidth - 1) },
	rowAdd() { S.canvasHeight++; S.canvas.push(Array.from({ length: S.canvasWidth }, () => emptyCell())) },
	rowDel() { if (S.canvasHeight < 2) return; S.canvasHeight--; S.canvas.pop(); U.y = Math.min(U.y, S.canvasHeight - 1) },
	rowAddAt() { S.canvasHeight++; S.canvas.splice(U.y, 0, Array.from({ length: S.canvasWidth }, () => emptyCell())) },
	rowDelAt() { if (S.canvasHeight < 2) return; S.canvas.splice(U.y, 1); S.canvasHeight--; U.y = Math.min(U.y, S.canvasHeight - 1) },
	colAddAt() { S.canvasWidth++; S.canvas.forEach(r => r.splice(U.x, 0, emptyCell())) },
	colDelAt() { if (S.canvasWidth < 2) return; S.canvas.forEach(r => r.splice(U.x, 1)); S.canvasWidth--; U.x = Math.min(U.x, S.canvasWidth - 1) },
	emptyCanvas() {
		if (!confirm("Svuotare la tela? (puoi annullare con ⌘Z)")) return
		Object.assign(S, { canvasWidth: 20, canvasHeight: 15, cellWidth: 20, cellHeight: 20, defaultFontSize: 20, layers: 1 })
		U.layer = 0
		U.hidden = [false]
		S.canvas = Array.from({ length: 15 }, () => Array.from({ length: 20 }, () => emptyCell()))
		U.x = U.y = 0
		A.deselect()
		requestAnimationFrame(fit)
	},
	cw(d) { S.cellWidth = Math.max(1, S.cellWidth + d) },
	ch(d) { S.cellHeight = Math.max(1, S.cellHeight + d) },
	fs(d) { S.defaultFontSize = Math.max(1, S.defaultFontSize + d) },
	// glyph sets
	setSlot(k) { K.sets[K.set][k] = [U.glyph.path, U.glyph.w, U.glyph.h, U.glyph.base]; store.set("sets", K) },
	useSlot(k) {
		const g = K.sets[K.set][k]
		if (!g || g[0] === EMPTY_PATH) return toast(`Slot ${k} vuoto — premi M, poi ${k}, per assegnarlo`)
		cell()[U.layer] =[...g.slice(0, 4), U.offX, U.sizeMod, U.rot, U.flip, U.inv, U.offY, C.fg]
	},
}

/* ---------- glyph / font ---------- */
async function loadFont(src, name) {
	try {
		const buf = typeof src === "string" ? await (await fetch(src)).arrayBuffer() : src
		font = Typr.parse(buf)
		fontName = name || (font.name && font.name.fullName) || "Font"
		$("curFont").textContent = fontName
		buildGlyphGrid()
		selectGlyph(0)
		sketchResults = []
		renderSketchResults()
		buildShapeIndex()
	} catch (e) {
		toast("Impossibile caricare il font")
		console.error(e)
	}
}
function glyphData(gid) {
	return {
		path: Typr.U.pathToSVG(Typr.U.glyphToPath(font, gid)) || EMPTY_PATH,
		w: font.hhea.advanceWidthMax,
		h: font.hhea.ascender + Math.abs(font.hhea.descender),
		base: font.hhea.descender,
		gid,
	}
}
function selectGlyph(gid, scroll = true) {
	if (!font) return
	gid = clamp(gid, 0, font.maxp.numGlyphs - 1)
	U.glyph = glyphData(gid)
	U.fromSketch = false
	const grid = $("glyphGrid")
	grid.querySelector(".sel")?.classList.remove("sel")
	const el = grid.children[gid]
	if (el) { el.classList.add("sel"); scroll && el.scrollIntoView({ block: "nearest" }) }
	refreshUI()
}

/* ---------- sketch search: draw a shape, get the most similar glyphs (+ rotated / mirrored / inverted) ---------- */
const SK = 16 // shapes are compared as 16×16 coverage maps
const VARIANTS = [[0, 1], [-90, 1], [-180, 1], [-270, 1], [0, -1], [-90, -1], [-180, -1], [-270, -1]] // [rotation, flip]
let shapeIndex = null, indexJob = 0, sketchResults = [], sketchSel = 0
// 3×3 box blur: makes rough strokes comparable to clean shapes
function blur(a) {
	const o = new Float32Array(SK * SK)
	for (let y = 0; y < SK; y++) for (let x = 0; x < SK; x++) {
		let t = 0, n = 0
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const yy = y + dy, xx = x + dx
			if (yy >= 0 && yy < SK && xx >= 0 && xx < SK) { t += a[yy * SK + xx]; n++ }
		}
		o[y * SK + x] = t / n
	}
	return o
}
// renders every glyph × 8 variants with the canvas' own matrix, in chunks so the UI never freezes
function buildShapeIndex() {
	const job = ++indexJob, f = font, n = f.maxp.numGlyphs, out = []
	const cnv = document.createElement("canvas")
	cnv.width = cnv.height = SK
	const ctx = cnv.getContext("2d", { willReadFrequently: true })
	shapeIndex = null
	let gid = 0
	const step = () => {
		if (job !== indexJob) return // font changed meanwhile
		const end = Math.min(n, gid + 60)
		for (; gid < end; gid++) {
			const g = glyphData(gid)
			if (g.path === EMPTY_PATH) continue
			const p2d = new Path2D(g.path)
			VARIANTS.forEach(([rot, flip]) => {
				const L = [g.path, g.w, g.h, g.base, 0, 0, rot, flip, false, 0, 0]
				ctx.setTransform(1, 0, 0, 1, 0, 0)
				ctx.clearRect(0, 0, SK, SK)
				ctx.setTransform(...layerMatrix(L, 0, 0, SK))
				ctx.fill(p2d)
				const d = ctx.getImageData(0, 0, SK, SK).data, a = new Float32Array(SK * SK)
				for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255
				out.push({ gid, rot, flip, map: blur(a) })
			})
		}
		if (gid < n) { renderSketchStatus(`Analizzo le forme del font… ${Math.round((gid / n) * 100)}%`); setTimeout(step, 0) }
		else { shapeIndex = out; renderSketchStatus(""); if (sketchHasInk()) searchSketch() }
	}
	step()
}
// sketch pad
const pad = $("sketchPad"), padCtx = pad.getContext("2d")
let padDrawing = false, padErase = false, lastStrokeEnd = 0, padInk = false, staleTimer
const NEW_SHAPE_AFTER = 1500 // ms: a stroke started after this pause begins a new shape (hold ⇧ to keep adding)
function sizePad() {
	const dpr = window.devicePixelRatio || 1, r = pad.getBoundingClientRect()
	if (!r.width) return
	pad.width = pad.height = Math.round(r.width * dpr)
	padCtx.setTransform(pad.width, 0, 0, pad.height, 0, 0) // draw in 0..1 units
	padInk = false
}
const sketchHasInk = () => padInk
function clearSketch() {
	padCtx.save(); padCtx.setTransform(1, 0, 0, 1, 0, 0); padCtx.clearRect(0, 0, pad.width, pad.height); padCtx.restore()
	padInk = false
	pad.classList.remove("stale")
}
const padPoint = e => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] }
pad.addEventListener("pointerdown", e => {
	e.preventDefault()
	if (!pad.width) sizePad()
	padErase = e.button === 2 || e.altKey
	if (!padErase && !e.shiftKey && performance.now() - lastStrokeEnd > NEW_SHAPE_AFTER) clearSketch()
	clearTimeout(staleTimer)
	pad.classList.remove("stale")
	pad.setPointerCapture(e.pointerId)
	padDrawing = true
	padCtx.globalCompositeOperation = padErase ? "destination-out" : "source-over"
	padCtx.lineWidth = padErase ? 0.16 : 0.09
	padCtx.lineCap = padCtx.lineJoin = "round"
	padCtx.strokeStyle = padCtx.fillStyle = "#111"
	const [x, y] = padPoint(e)
	padCtx.beginPath(); padCtx.moveTo(x, y); padCtx.lineTo(x + 0.0001, y); padCtx.stroke()
	padInk = true
})
pad.addEventListener("pointermove", e => {
	if (!padDrawing) return
	const [x, y] = padPoint(e)
	padCtx.lineTo(x, y); padCtx.stroke()
})
const endStroke = () => {
	if (!padDrawing) return
	padDrawing = false
	lastStrokeEnd = performance.now()
	clearTimeout(staleTimer)
	staleTimer = setTimeout(() => pad.classList.add("stale"), NEW_SHAPE_AFTER)
	searchSketch()
}
pad.addEventListener("pointerup", endStroke)
pad.addEventListener("pointercancel", endStroke)
pad.addEventListener("contextmenu", e => e.preventDefault())
$("sketchClear").onclick = () => { clearSketch(); sketchResults = []; renderSketchResults() }

// sketch → 16×16 coverage, plus a version with closed outlines filled in (so drawing just the contour works too)
function sketchMaps() {
	const W = pad.width, d = padCtx.getImageData(0, 0, W, W).data
	const G = 64, fine = new Uint8Array(G * G), cnt = new Uint32Array(G * G)
	const raw = new Float32Array(SK * SK), rc = new Uint32Array(SK * SK)
	for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
		const a = d[(y * W + x) * 4 + 3] / 255
		const gi = ((y * G / W) | 0) * G + ((x * G / W) | 0)
		if (a > 0.4) fine[gi] = 1
		cnt[gi]++
		const si = ((y * SK / W) | 0) * SK + ((x * SK / W) | 0)
		raw[si] += a; rc[si]++
	}
	for (let i = 0; i < raw.length; i++) raw[i] /= rc[i] || 1
	// flood the empty space from the border; whatever stays unreached is enclosed → filled
	const seen = new Uint8Array(G * G), stack = []
	for (let i = 0; i < G; i++) [i, (G - 1) * G + i, i * G, i * G + G - 1].forEach(j => { if (!fine[j] && !seen[j]) { seen[j] = 1; stack.push(j) } })
	while (stack.length) {
		const j = stack.pop(), x = j % G, y = (j / G) | 0
		;[[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
			const xx = x + dx, yy = y + dy, k = yy * G + xx
			if (xx >= 0 && xx < G && yy >= 0 && yy < G && !fine[k] && !seen[k]) { seen[k] = 1; stack.push(k) }
		})
	}
	const filled = Float32Array.from(raw)
	for (let j = 0; j < G * G; j++) if (!fine[j] && !seen[j]) {
		const si = (((j / G) | 0) * SK / G | 0) * SK + ((j % G) * SK / G | 0)
		filled[si] = Math.min(1, filled[si] + (SK * SK) / (G * G)) // one fine cell = 1/16 of a coarse cell
	}
	return [blur(raw), blur(filled)]
}
function searchSketch() {
	if (!padInk) return
	if (!shapeIndex) return renderSketchStatus("Analizzo le forme del font…")
	const maps = sketchMaps()
	if (!maps[0].some(v => v > 0.02)) { sketchResults = []; return renderSketchResults() }
	const scored = []
	for (const e of shapeIndex) {
		for (const inv of [false, true]) {
			// soft IoU (overlap / union): penalises both missing and extra ink, so thin strokes don't match empty glyphs
			let best = Infinity
			for (const m of maps) {
				let mn = 0, mx = 0
				for (let i = 0; i < m.length; i++) { const g = inv ? 1 - e.map[i] : e.map[i]; mn += Math.min(g, m[i]); mx += Math.max(g, m[i]) }
				const d = mx > 0 ? 1 - mn / mx : 1
				if (d < best) best = d
			}
			scored.push({ e, inv, score: best })
		}
	}
	scored.sort((a, b) => a.score - b.score)
	// drop look-alikes (symmetric glyphs give identical variants)
	const seenKeys = new Set(), res = []
	for (const s of scored) {
		const key = Array.from(s.e.map, v => Math.round((s.inv ? 1 - v : v) * 6)).join("")
		if (seenKeys.has(key)) continue
		seenKeys.add(key)
		res.push({ gid: s.e.gid, rot: s.e.rot, flip: s.e.flip, inv: s.inv })
		if (res.length >= 48) break
	}
	sketchResults = res
	sketchSel = 0
	U.resultsFocus = true
	renderSketchResults()
	pickSketch(0)
}
function pickSketch(i) {
	if (!sketchResults.length) return
	sketchSel = (i + sketchResults.length) % sketchResults.length
	const r = sketchResults[sketchSel]
	U.glyph = glyphData(r.gid)
	Object.assign(U, { rot: r.rot, flip: r.flip, inv: r.inv, sizeMod: 0, offX: 0, offY: 0, fromSketch: true })
	$("sketchResults").querySelectorAll(".sel").forEach(el => el.classList.remove("sel"))
	const el = $("sketchResults").children[sketchSel]
	if (el) { el.classList.add("sel"); el.scrollIntoView({ block: "nearest" }) }
	refreshUI()
}
const variantSvg = (L, px) => `<svg viewBox="0 0 ${px} ${px}"><path transform="matrix(${layerMatrix(L, 0, 0, px).map(r3).join(" ")})" d="${layerPath(L)}"/></svg>`
function renderSketchResults() {
	$("sketchResults").innerHTML = sketchResults.map((r, i) => {
		const g = glyphData(r.gid)
		return `<button class="res ${i === sketchSel ? "sel" : ""}" data-res="${i}" title="#${r.gid + 1}${r.rot ? " ↻" + -r.rot + "°" : ""}${r.flip < 0 ? " specchiato" : ""}${r.inv ? " invertito" : ""}">${variantSvg([g.path, g.w, g.h, g.base, 0, 0, r.rot, r.flip, r.inv, 0, 0], 40)}</button>`
	}).join("")
	$("sketchResults").classList.toggle("empty", !sketchResults.length)
	refreshUI()
}
function renderSketchStatus(msg) { $("sketchStatus").textContent = msg }
$("sketchResults").addEventListener("click", e => {
	const b = e.target.closest("[data-res]")
	if (b) { U.resultsFocus = true; pickSketch(+b.dataset.res) }
})
const CREDITS = {
	"fonts/unscii-16.ttf": "http://pelulamu.net/unscii/",
	"fonts/submona.ttf": "https://github.com/pera/submona-web-font",
	"fonts/RayMantaC64-Regular.otf": "http://datadoor.net/",
	"fonts/ImagoMundiMei-Regular.otf": "http://velvetyne.fr/imagomundimei/",
}
let glyphObserver
function buildGlyphGrid() {
	const grid = $("glyphGrid")
	grid.innerHTML = ""
	glyphObserver?.disconnect()
	glyphObserver = new IntersectionObserver(es => es.forEach(e => {
		if (!e.isIntersecting) return
		drawThumb(e.target)
		glyphObserver.unobserve(e.target)
	}), { root: grid, rootMargin: "200px" })
	const frag = document.createDocumentFragment()
	for (let i = 0; i < font.maxp.numGlyphs; i++) {
		const d = document.createElement("div")
		d.className = "g"
		d.dataset.gid = i
		d.title = "#" + (i + 1)
		d.innerHTML = `<canvas></canvas><i>${i + 1}</i>`
		frag.appendChild(d)
	}
	grid.appendChild(frag)
	;[...grid.children].forEach(c => glyphObserver.observe(c))
}
function drawThumb(el) {
	const cnv = el.firstChild, dpr = window.devicePixelRatio || 1, px = Math.round(36 * dpr)
	cnv.width = cnv.height = px
	const ctx = cnv.getContext("2d"), inv = $("glyphInvert").checked
	const asc = font.hhea.ascender, h = asc - font.hhea.descender, s = (px * 0.82) / h, pad = px * 0.09
	if (inv) { ctx.fillStyle = "#111"; ctx.fillRect(pad, pad, h * s, h * s) }
	ctx.translate(pad, pad + asc * s)
	ctx.scale(s, -s)
	ctx.beginPath()
	Typr.U.pathToContext(Typr.U.glyphToPath(font, +el.dataset.gid), ctx)
	ctx.fillStyle = inv ? "#f5f5f5" : "#111"
	ctx.fill()
}
const glyphPreview = (path, h, base) => `<svg viewBox="0 0 ${h} ${h}" preserveAspectRatio="xMidYMid meet"><path transform="matrix(1 0 0 -1 0 ${h + base})" d="${path}"/></svg>`

/* ---------- rendering ---------- */
const stage = $("stage"), world = $("world"), sheet = $("paper"), art = $("art")
let bgEls = [], fgEls = [], cellCache = [], structKey = ""
function cellFg(c, x, y) {
	let s = ""
	for (let z = 0; z < S.layers; z++) {
		const L = c[z]
		if (isEmpty(L) || U.hidden[z]) continue
		s += `<path transform="matrix(${layerMatrix(L, x, y).map(r3).join(" ")})" d="${layerPath(L)}" fill="${rgbOf(L[10])}"/>`
	}
	return s
}
const cellBg = (c, x, y) => (c[BG()][0] == 255 ? "" : `<rect x="${x * S.cellWidth}" y="${y * S.cellHeight}" width="${S.cellWidth}" height="${S.defaultFontSize}" fill="${rgbOf(c[BG()][0])}"/>`)

function render() {
	const W = S.canvasWidth, H = S.canvasHeight, cw = S.cellWidth, ch = S.cellHeight
	U.hidden = range(S.layers).map(z => !!U.hidden[z]) // keep in step with the layer count (undo, open…)
	const sk = JSON.stringify([W, H, cw, ch, S.defaultFontSize, S.layers, U.hidden, C.pal, palette(), C.cohesion, C.cohColor])
	if (sk !== structKey) {
		structKey = sk
		const pw = W * cw, ph = H * ch
		sheet.style.width = pw + "px"
		sheet.style.height = ph + "px"
		art.setAttribute("width", pw)
		art.setAttribute("height", ph)
		const bgL = $("bgLayer"), fgL = $("fgLayer")
		bgL.innerHTML = fgL.innerHTML = ""
		bgEls = []; fgEls = []; cellCache = []
		const NS = "http://www.w3.org/2000/svg"
		for (let i = 0; i < W * H; i++) {
			bgEls.push(bgL.appendChild(document.createElementNS(NS, "g")))
			fgEls.push(fgL.appendChild(document.createElementNS(NS, "g")))
		}
		// grid as one path per weight; every 5th line is darker for counting cells
		const ui = $("ui"), minor = [], major = []
		ui.setAttribute("width", pw)
		ui.setAttribute("height", ph)
		for (let x = 0; x <= W; x++) (x % 5 ? minor : major).push(`M${x * cw} 0V${ph}`)
		for (let y = 0; y <= H; y++) (y % 5 ? minor : major).push(`M0 ${y * ch}H${pw}`)
		$("gridMinor").setAttribute("d", minor.join(""))
		$("gridMajor").setAttribute("d", major.join(""))
		$("colNums").innerHTML = Array.from({ length: W }, (_, i) => `<span style="left:${i * cw}px;width:${cw}px">${i + 1}</span>`).join("")
		$("rowNums").innerHTML = Array.from({ length: H }, (_, i) => `<span style="top:${i * ch}px;height:${ch}px">${i + 1}</span>`).join("")
	}
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const i = y * W + x, c = S.canvas[y][x], k = JSON.stringify(c)
		if (cellCache[i] === k) continue
		cellCache[i] = k
		bgEls[i].innerHTML = cellBg(c, x, y)
		fgEls[i].innerHTML = cellFg(c, x, y)
	}
	// cursor, selection, numbers
	setRect($("curRect"), U.x, U.y, U.x, U.y)
	const a = selArea(), selEl = $("selRect")
	if (a) setRect(selEl, a[0][1], a[0][0], a[1][1], a[1][0])
	selEl.style.display = a ? "" : "none"
	selEl.classList.toggle("live", !!a && !U.sel.end)
	$("colNums").querySelector(".hl")?.classList.remove("hl")
	$("rowNums").querySelector(".hl")?.classList.remove("hl")
	$("colNums").children[U.x]?.classList.add("hl")
	$("rowNums").children[U.y]?.classList.add("hl")
	applyView()
}
function setRect(el, x0, y0, x1, y1) {
	el.setAttribute("x", x0 * S.cellWidth)
	el.setAttribute("y", y0 * S.cellHeight)
	el.setAttribute("width", (x1 - x0 + 1) * S.cellWidth)
	el.setAttribute("height", (y1 - y0 + 1) * S.cellHeight)
}
function applyView() {
	// integer pan keeps cell edges on whole device pixels (no blurry hairlines)
	U.panX = Math.round(U.panX)
	U.panY = Math.round(U.panY)
	world.style.transform = `translate(${U.panX}px, ${U.panY}px) scale(${U.zoom})`
	$("zoomPct").textContent = Math.round(U.zoom * 100) + "%"
	world.style.setProperty("--inv", 1 / U.zoom) // keeps row/col numbers readable at any zoom
}

function refreshUI() {
	const L = cell()[U.layer]
	// shows the glyph exactly as Q will place it (rotation, mirror, invert included)
	$("curGlyph").innerHTML = variantSvg([U.glyph.path, U.glyph.w, U.glyph.h, U.glyph.base, 0, 0, U.rot, U.flip, U.inv, 0, 0], 64).replace(/^<svg[^>]*>|<\/svg>$/g, "")
	$("curGlyph").setAttribute("viewBox", "0 0 64 64")
	$("sketchResults").classList.toggle("focus", !!U.resultsFocus && sketchResults.length > 0)
	$("curGlyph").style.fill = rgbOf(C.fg)
	$("curGlyph").style.background = C.bg == 255 ? "#fff" : rgbOf(C.bg)
	$("curGid").textContent = U.glyph.gid == null ? "copiato" : "#" + (U.glyph.gid + 1)
	$("sizeVal").textContent = L[5] + " px"
	$("offVal").textContent = `${L[4]}, ${L[9]}`
	// layers
	$("layers").innerHTML = range(S.layers).reverse().map(z => `
		<div class="layer ${z === U.layer ? "active" : ""} ${U.hidden[z] ? "off" : ""}" data-layer="${z}" draggable="true">
			<button class="eye" data-lhide="${z}" title="Mostra / nascondi">${U.hidden[z] ? "◌" : "●"}</button>
			<span class="lname">Layer ${z + 1}</span>
		</div>`).join("")
	$("layerDel").disabled = S.layers < 2
	// glyph sets
	const set = K.sets[K.set]
	$("slots").innerHTML = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map(k => {
		const g = set[k]
		return `<button class="slot" data-slot="${k}" title="Tasto ${k}"><i>${k}</i>${g && g[0] !== EMPTY_PATH ? glyphPreview(g[0], g[2] == 1 ? 800 : g[2], g[3]) : ""}</button>`
	}).join("")
	$("setLabel").textContent = `${K.set + 1}/${K.sets.length}`
	$("toggleMapping").checked = U.mapping
	document.body.classList.toggle("mapping", U.mapping)
	document.body.classList.toggle("typing", U.typing)
	$("toolPaint").classList.toggle("on", U.paint)
	$("toolType").classList.toggle("on", U.typing)
	$("toolGrid").classList.toggle("on", !U.hideGrid)
	document.body.classList.toggle("hideGrid", !!U.hideGrid)
	// canvas tab
	$("wVal").textContent = `${S.canvasWidth} celle (${S.canvasWidth * S.cellWidth} px)`
	$("hVal").textContent = `${S.canvasHeight} celle (${S.canvasHeight * S.cellHeight} px)`
	$("cwVal").textContent = S.cellWidth + " px"
	$("chVal").textContent = S.cellHeight + " px"
	$("fsVal").textContent = S.defaultFontSize + " px"
	const mm = px => ((px / U.dpi) * 25.4).toFixed(2)
	$("mmVal").textContent = `${mm(S.canvasWidth * S.cellWidth)} × ${mm(S.canvasHeight * S.cellHeight)} mm`
	$("pngSize").textContent = `${S.canvasWidth * S.cellWidth * U.exportScale} × ${S.canvasHeight * S.cellHeight * U.exportScale} px`
	refreshColors()
	// status bar
	$("stPos").textContent = `x:${U.x + 1} y:${U.y + 1}`
	$("stLayer").textContent = `Layer ${U.layer + 1}`
	const a = selArea()
	$("stSel").textContent = a ? `Selezione ${a[1][1] - a[0][1] + 1}×${a[1][0] - a[0][0] + 1}${U.sel.end ? "" : " (⇧S per bloccare)"}` : ""
	const chips = [U.mapping && "MAPPA", U.paint && "PENNELLO", U.typing && "SCRITTURA", U.offsetHeld && "OFFSET", C.brushFg && "COLORE FG", C.brushBg && "COLORE BG"].filter(Boolean)
	$("stMode").innerHTML = chips.map(c => `<span class="chip">${c}</span>`).join("")
	// the hint line shows what you can do right now
	$("stHint").textContent =
		U.typing ? "Digita per scrivere col font · Invio a capo · Esc esce" :
		U.resultsFocus && sketchResults.length ? "← → ↑ ↓ scegli la forma · Q / Invio la disegna al cursore · Tab o clic sulla tela per tornare alla tela" :
		U.mapping ? "Premi 1–0 (o clicca uno slot) per assegnare il glyph corrente · M per finire" :
		a ? "⌘C copia · ⌘X taglia · Canc svuota · ⇧Q riempi · ⇧M specchia · ⇧R ruota · ⇧HJKL sposta · Esc deseleziona" :
		U.paint ? "Trascina per disegnare · Alt + trascina = gomma · G per uscire" :
		"Q disegna · E cancella · R ruota · F specchia · G pennello · ⇧+trascina seleziona · ⌘V incolla · ? scorciatoie"
}

let paletteKey = ""
function refreshColors() {
	$("fgSwatch").style.background = rgbOf(C.fg)
	$("bgSwatch").style.background = C.bg == 255 ? "repeating-linear-gradient(45deg,#fff 0 4px,#ddd 4px 8px)" : rgbOf(C.bg)
	let idx = [...Array(256).keys()]
	if (C.onlyUsed) {
		const used = new Set()
		S.canvas.forEach(r => r.forEach(c => { c.slice(0, -1).forEach(L => !isEmpty(L) && used.add(L[10])); c[BG()][0] != 255 && used.add(+c[BG()][0]) }))
		idx = idx.filter(i => used.has(i))
	}
	const k = JSON.stringify([idx, palette(), C.cohesion, C.cohColor, C.fg, C.bg])
	if (k !== paletteKey) {
		paletteKey = k
		$("palette").innerHTML = idx.map(i => `<div data-c="${i}" class="${i === C.fg ? "fg" : ""} ${i === C.bg ? "bg" : ""}" style="background:${rgbOf(i)}" title="${i}"></div>`).join("")
	}
	const target = C.editCohesion ? C.cohColor : palette()[C.fg]
	$("editLabel").textContent = C.editCohesion ? "coesione" : "colore #" + C.fg
	$("rgb").querySelectorAll("input").forEach(inp => { inp.value = target[+inp.dataset.ch] })
	$("palLabel").textContent = `${C.pal + 1}/${C.palettes.length}`
	$("cohVal").textContent = Math.round(C.cohesion * 100) + "%"
	$("cohesion").value = C.cohesion
}

// run an action, then re-render and record history
function act(fn) {
	fn()
	render()
	refreshUI()
	commit()
}

/* ---------- view: zoom & pan ---------- */
function fit() {
	const r = stage.getBoundingClientRect(), pw = S.canvasWidth * S.cellWidth, ph = S.canvasHeight * S.cellHeight
	U.zoom = clamp(Math.min((r.width - 80) / pw, (r.height - 80) / ph), 0.1, 3)
	U.panX = (r.width - pw * U.zoom) / 2
	U.panY = (r.height - ph * U.zoom) / 2
	render()
}
function zoomAt(f, cx, cy) {
	const r = stage.getBoundingClientRect()
	cx ??= r.width / 2; cy ??= r.height / 2
	const nz = clamp(U.zoom * f, 0.05, 20)
	U.panX = cx - ((cx - U.panX) * nz) / U.zoom
	U.panY = cy - ((cy - U.panY) * nz) / U.zoom
	U.zoom = nz
	applyView()
}
stage.addEventListener("wheel", e => {
	e.preventDefault()
	if (e.ctrlKey || e.metaKey) {
		const r = stage.getBoundingClientRect()
		zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
	} else {
		U.panX -= e.deltaX
		U.panY -= e.deltaY
		applyView()
	}
}, { passive: false })

/* ---------- mouse on canvas ---------- */
let mouse = { down: false, mode: null, panFrom: null }
function cellAt(e) {
	const r = sheet.getBoundingClientRect()
	return [
		clamp(Math.floor((e.clientX - r.left) / U.zoom / S.cellWidth), 0, S.canvasWidth - 1),
		clamp(Math.floor((e.clientY - r.top) / U.zoom / S.cellHeight), 0, S.canvasHeight - 1),
	]
}
function paintAt(e) {
	if (U.paint) cell()[U.layer] = e.altKey ? emptyLayer() : selectedGlyph()
	if (C.brushFg) cell()[U.layer][10] = e.altKey ? 0 : C.fg
	if (C.brushBg) cell()[BG()] = [e.altKey ? 255 : C.bg]
}
stage.addEventListener("mousedown", e => {
	if (e.button === 1 || (e.button === 0 && e.target === stage && !e.shiftKey)) {
		mouse = { down: true, mode: "pan", panFrom: [e.clientX - U.panX, e.clientY - U.panY] }
		return
	}
	if (e.button !== 0 || !sheet.contains(e.target)) return
	e.preventDefault()
	stage.focus()
	U.resultsFocus = false
	;[U.x, U.y] = cellAt(e)
	if (e.shiftKey) {
		U.sel = { start: [U.y, U.x], end: null }
		mouse = { down: true, mode: "select" }
	} else {
		mouse = { down: true, mode: "draw" }
		paintAt(e)
	}
	render(); refreshUI()
})
stage.addEventListener("mousemove", e => {
	const hr = $("hoverRect")
	if (!sheet.contains(e.target)) return (hr.style.display = "none")
	const [x, y] = cellAt(e)
	hr.style.display = ""
	setRect(hr, x, y, x, y)
})
stage.addEventListener("mouseleave", () => ($("hoverRect").style.display = "none"))
window.addEventListener("mousemove", e => {
	if (!mouse.down) return
	if (mouse.mode === "pan") {
		U.panX = e.clientX - mouse.panFrom[0]
		U.panY = e.clientY - mouse.panFrom[1]
		return applyView()
	}
	const [x, y] = cellAt(e)
	if (x === U.x && y === U.y) return
	U.x = x; U.y = y
	if (mouse.mode === "draw") paintAt(e)
	render(); refreshUI()
})
window.addEventListener("mouseup", () => {
	if (!mouse.down) return
	if (mouse.mode === "select") {
		const a = selArea()
		U.sel = a[0][0] === a[1][0] && a[0][1] === a[1][1] ? { start: null, end: null } : { start: a[0], end: a[1] }
	}
	mouse.down = false
	act(() => {})
})

/* ---------- keyboard ---------- */
const SLOT_KEYS = "1234567890"
function onKey(e) {
	const t = e.target
	if (isEditing(t)) {
		if (e.key === "Escape") t.blur()
		return
	}
	if (!$("helpModal").classList.contains("hidden")) {
		if (e.key === "Escape" || e.key === "?") { $("helpModal").classList.add("hidden"); e.preventDefault() }
		return
	}
	const cmd = IS_MAC ? e.metaKey : e.ctrlKey
	const exportMod = IS_MAC ? e.metaKey : e.ctrlKey && e.altKey
	const k = e.key.length === 1 ? (e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase()) : e.key
	const kc = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : k.toLowerCase()

	// app-level commands
	if (exportMod && e.shiftKey && kc === "c") return run(e, copySvg)
	if (exportMod && kc === "e") return run(e, e.shiftKey ? exportPng : exportSvg)
	if (cmd && kc === "z") return run(e, () => act(e.shiftKey ? redo : undo))
	if (cmd && kc === "y") return run(e, () => act(redo))
	if (cmd && kc === "s") return run(e, () => saveFile(false))
	if (cmd && kc === "o") return run(e, () => $("openFile").click())
	if (cmd && kc === "a") return run(e, () => act(A.selectAll))
	if (cmd && kc === "c") return keyCopy(e, false)
	if (cmd && kc === "x") return keyCopy(e, true)
	if (cmd && kc === "v") return keyPaste()
	if (e.metaKey) return // leave other browser shortcuts alone

	if (U.typing) return typingKey(e)
	if (e.key === "Tab" && sketchResults.length) return run(e, () => { U.resultsFocus = !U.resultsFocus; refreshUI() })
	if (U.resultsFocus && sketchResults.length && !e.ctrlKey && !e.altKey) {
		const cols = Math.max(1, Math.round($("sketchResults").clientWidth / ($("sketchResults").firstElementChild?.offsetWidth || 40)))
		const nav = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }
		if (e.key in nav) return run(e, () => pickSketch(sketchSel + nav[e.key]))
		if (e.key === "Escape") return run(e, () => { U.resultsFocus = false; refreshUI() })
		if (k === "q" || e.key === "Enter") return run(e, () => { U.resultsFocus = false; act(A.insert) })
	}
	if (e.key === "?" || (e.shiftKey && e.code === "Slash")) return run(e, () => $("helpModal").classList.remove("hidden"))

	const all = e.ctrlKey
	const alt = e.altKey
	if (U.mapping && SLOT_KEYS.includes(k)) return run(e, () => act(() => A.setSlot(k)))
	const map = {
		ArrowRight: () => A.move(1, 0, alt), ArrowLeft: () => A.move(-1, 0, alt),
		ArrowDown: () => A.move(0, 1, alt), ArrowUp: () => A.move(0, -1, alt),
		d: () => A.move(1, 0, alt), a: () => A.move(-1, 0, alt), s: () => A.move(0, 1, alt), w: () => A.move(0, -1, alt),
		q: A.insert, Enter: A.insert,
		e: () => A.erase(all), " ": () => A.erase(false),
		// Canc/Backspace (also with ⇧) empty the whole selection; without one they act on the cursor
		Delete: () => (selArea() ? A.clearArea(true) : A.erase(all)),
		Backspace: () => (selArea() ? A.clearArea(true) : A.backspace()),
		r: () => A.rotate(all), f: () => A.flip(all), i: () => A.invert(all),
		c: A.copyGlyph, v: () => A.colorFg(all), b: A.colorBg,
		h: () => (U.hideGrid = !U.hideGrid),
		g: () => (U.paint = !U.paint),
		t: () => { U.typing = true; typingCheck() },
		m: () => (U.mapping = !U.mapping),
		",": () => A.selectLayer(-1), ".": () => A.selectLayer(1),
		"[": () => (U.fromSketch ? pickSketch(sketchSel - 1) : selectGlyph(U.glyph.gid - 1)),
		"]": () => (U.fromSketch ? pickSketch(sketchSel + 1) : selectGlyph(U.glyph.gid + 1)),
		"{": () => selectGlyph(U.glyph.gid - 10), "}": () => selectGlyph(U.glyph.gid + 10),
		"+": () => zoomAt(1.15), "=": () => zoomAt(1.15), "-": () => zoomAt(1 / 1.15),
		Escape: () => { A.deselect(); U.mapping = false; U.paint = false },
		"?": () => $("helpModal").classList.remove("hidden"),
		A: A.selectAll, S: A.makeSelection, D: A.deselect,
		C: () => A.pasteSelection(all), M: () => A.mirrorArea(all), F: () => A.flipArea(all),
		Q: () => A.fill(all), E: () => A.clearArea(all), I: () => A.invertArea(all),
		Y: A.rotateEachArea, U: A.flipEachArea, R: () => A.rotateArea(all), T: A.transposeArea,
		H: () => A.shiftArea(all, -1, 0), J: () => A.shiftArea(all, 0, 1), K: () => A.shiftArea(all, 0, -1), L: () => A.shiftArea(all, 1, 0),
		V: () => A.colorFgArea(all), B: () => A.fillBgArea(all),
	}
	if (SLOT_KEYS.includes(k)) map[k] = () => A.useSlot(k)
	if ("CMFQEIYURTHJKLVB".includes(k) && k.length === 1 && !selArea()) return run(e, () => toast("Prima seleziona un'area: ⇧ + trascina, oppure ⇧S"))
	// hold-keys
	if (k === "o") { U.offsetHeld = true; refreshUI(); return e.preventDefault() }
	if (k === "p") { document.body.classList.add("preview"); return e.preventDefault() }
	if (k === "x") { if (!e.repeat) showQuickColor(); return e.preventDefault() }
	const fn = map[k] || map[e.key]
	if (fn) run(e, () => act(fn))
}
function run(e, fn) { e.preventDefault(); fn() }
document.addEventListener("keydown", onKey)
document.addEventListener("keyup", e => {
	if (e.key.toLowerCase() === "o") { U.offsetHeld = false; refreshUI() }
	if (e.key.toLowerCase() === "p") document.body.classList.remove("preview")
	if (e.key.toLowerCase() === "x") $("quickColor").classList.add("hidden")
})
window.addEventListener("blur", () => { U.offsetHeld = false; document.body.classList.remove("preview") })

function typingKey(e) {
	const nav = { ArrowRight: () => A.move(1, 0), ArrowLeft: () => A.move(-1, 0), ArrowDown: () => A.move(0, 1), ArrowUp: () => A.move(0, -1), Backspace: A.backspace, Enter: A.enter, Escape: () => (U.typing = false) }
	if (nav[e.key]) return run(e, () => act(nav[e.key]))
	if (e.key.length !== 1 || e.ctrlKey || e.altKey || !font) return
	e.preventDefault()
	const gid = Typr.U.codeToGlyph(font, e.key.codePointAt(0))
	if (!gid) return toast(`"${e.key}" non esiste in ${fontName} — per scrivere usa Unscii, RayMantaC64 o Submona`)
	act(() => {
		const g = glyphData(gid)
		cell()[U.layer] = [g.path, g.w, g.h, g.base, U.offX, U.sizeMod, U.rot, U.flip, U.inv, U.offY, C.fg]
		if (++U.x >= S.canvasWidth) { U.x = 0; U.y = Math.min(U.y + 1, S.canvasHeight - 1) }
	})
}

function showQuickColor() {
	const q = $("quickColor"), cr = $("curRect").getBoundingClientRect(), sr = stage.getBoundingClientRect()
	q.innerHTML = [...Array(256).keys()].map(i => `<div data-c="${i}" style="background:${rgbOf(i)}"></div>`).join("")
	q.classList.remove("hidden")
	q.style.left = clamp(cr.right - sr.left + 8, 0, sr.width - 250) + "px"
	q.style.top = clamp(cr.top - sr.top, 0, sr.height - 260) + "px"
}

/* ---------- clean export ---------- */
let exportInfo = ""
function buildSvg(forPng) {
	const withBg = $("exportBg").checked
	// groups only, no merging: layer → color → one path per shape (Illustrator: easy to select by group)
	const groups = (id, byColor) => {
		out.push(`<g id="${id}">`)
		byColor.forEach((els, col) => out.push(`<g id="${id}-${hexOf(col).slice(1)}" fill="${hexOf(col)}">`, ...els, `</g>`))
		out.push(`</g>`)
	}
	const push = (map, col, el) => { map.has(col) || map.set(col, []); map.get(col).push(el); colors.add(col); nPaths++ }
	// a locked selection exports just that area, shifted to the origin
	const a = !forPng && $("exportSel").checked && U.sel.end ? selArea() : null
	const [[sy, sx], [ey, ex]] = a || [[0, 0], [S.canvasHeight - 1, S.canvasWidth - 1]]
	const grid = S.canvas.slice(sy, ey + 1).map(r => r.slice(sx, ex + 1))
	const W = grid[0].length * S.cellWidth, H = grid.length * S.cellHeight
	// mm: Illustrator reads physical units, so the artboard matches the print size set in Tela → DPI
	const mm = !forPng && $("exportUnit").value === "mm"
	const size = v => (mm ? r3((v / U.dpi) * 25.4) + "mm" : v)
	const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${size(W)}" height="${size(H)}" viewBox="0 0 ${W} ${H}">`]
	let nPaths = 0
	const colors = new Set()
	if (withBg) {
		// one rect per horizontal run of equal background cells, grouped by color
		const byColor = new Map()
		grid.forEach((row, y) => {
			for (let x = 0; x < row.length;) {
				const col = +row[x][BG()][0]
				let e = x
				while (e + 1 < row.length && +row[e + 1][BG()][0] === col) e++
				if (col !== 255) push(byColor, col, `<rect x="${x * S.cellWidth}" y="${y * S.cellHeight}" width="${(e - x + 1) * S.cellWidth}" height="${S.defaultFontSize}"/>`)
				x = e + 1
			}
		})
		if (byColor.size) groups("sfondo", byColor)
	}
	for (let z = 0; z < S.layers; z++) {
		if (U.hidden[z]) continue
		const byColor = new Map()
		grid.forEach((row, y) => row.forEach((c, x) => {
			const L = c[z]
			if (isEmpty(L)) return
			bakeShapes(layerPath(L), layerMatrix(L, x, y)).forEach(d => push(byColor, L[10], `<path d="${d}"/>`))
		}))
		if (byColor.size) groups(`layer-${z + 1}`, byColor)
	}
	out.push(`</svg>`)
	exportInfo = `${a ? `selezione ${ex - sx + 1}×${ey - sy + 1}` : "tutta la tela"} · ${nPaths} tracciati · ${colors.size} colori${mm ? ` · ${size(W)}×${size(H)}` : ""}`
	return out.join("\n")
}
function download(blob, name) {
	const a = document.createElement("a")
	a.href = URL.createObjectURL(blob)
	a.download = name
	a.click()
	setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
const fname = () => (U.fileName || "Untitled").replace(/[\\/:*?"<>|]/g, "_")
function exportSvg() { download(new Blob([buildSvg()], { type: "image/svg+xml" }), fname() + ".svg"); toast("SVG esportato — " + exportInfo) }
/* area clipboard: whole cells (4 layers + background). ⌘C also puts the area's SVG on the system
   clipboard, so the same copy pastes here (⌘V) and in Illustrator. */
let cellClipboard = null, clipHandled = false
const GDC_MIME = "application/x-gdc-cells"
const isEditing = t => !!(t?.matches?.("input[type=text], input[type=number], input:not([type]), select, textarea") || t?.isContentEditable)
// copies the selected area (or the cursor cell) into cellClipboard; returns what goes on the system clipboard
function copyCells(cut) {
	if (U.sel.start && !U.sel.end) A.makeSelection() // lock a live selection
	const a = selArea() || [[U.y, U.x], [U.y, U.x]]
	const [[sy, sx], [ey, ex]] = a
	cellClipboard = clone(S.canvas.slice(sy, ey + 1).map(r => r.slice(sx, ex + 1)))
	// built before a cut empties the area; a single cell has no locked selection, so no SVG then
	const svg = U.sel.end ? buildSvg() : ""
	toast(`${cut ? "Tagliato" : "Copiato"} ${ex - sx + 1}×${ey - sy + 1} — ⌘V qui${svg ? " o in Illustrator" : ""}`)
	if (cut) act(() => eachInArea(a, (c, x, y) => (S.canvas[y][x] = emptyCell())))
	else render(), refreshUI()
	return { svg, json: JSON.stringify(cellClipboard) }
}
// Clipboard events are the main path: they fire for ⌘C/⌘X/⌘V and also for Edit-menu shortcuts
// (e.g. browser/app fullscreen, where the menu swallows the keydown).
function onCopyCut(e, cut) {
	if (isEditing(e.target)) return
	e.preventDefault()
	clipHandled = true
	const { svg, json } = copyCells(cut)
	if (svg) e.clipboardData.setData("text/plain", svg)
	e.clipboardData.setData(GDC_MIME, json)
}
document.addEventListener("copy", e => onCopyCut(e, false))
document.addEventListener("cut", e => onCopyCut(e, true))
document.addEventListener("paste", e => {
	if (isEditing(e.target)) return
	e.preventDefault()
	clipHandled = true
	const raw = e.clipboardData.getData(GDC_MIME)
	if (raw) {
		try {
			const rows = JSON.parse(raw)
			if (Array.isArray(rows) && rows.length && rows.length * rows[0].length <= 250000) {
				const n = clamp(Math.max(...rows.flat().map(c => (Array.isArray(c) ? c.length - 1 : 1))), 1, MAX_LAYERS)
				cellClipboard = rows.map(r => r.map(c => cleanCell(c, n)))
			}
		} catch (err) { /* not ours: keep the in-app clipboard */ }
	}
	act(pasteCells)
})
// keyboard fallback for browsers that skip clipboard events when nothing is text-selected
function keyCopy(e, cut) {
	e.preventDefault()
	clipHandled = false
	try { document.execCommand(cut ? "cut" : "copy") } catch (err) {}
	if (clipHandled) return
	const { svg } = copyCells(cut)
	if (svg) navigator.clipboard?.writeText(svg).catch(() => {})
}
function keyPaste() {
	clipHandled = false // let the native paste event fire; use the in-app clipboard if it doesn't
	setTimeout(() => { if (!clipHandled) act(pasteCells) }, 60)
}
// adds layers if incoming cells have more, pads incoming cells if they have fewer
function fitCell(c) {
	const n = c.length - 1
	while (S.layers < Math.min(n, MAX_LAYERS)) { S.canvas.forEach(r => r.forEach(k => k.splice(S.layers, 0, emptyLayer()))); S.layers++ }
	return [...range(S.layers).map(i => (i < n ? clone(c[i]) : emptyLayer())), c[n].slice()]
}
function pasteCells() {
	if (!cellClipboard) return toast("Niente da incollare — seleziona un'area e premi ⌘C")
	const h = cellClipboard.length, w = cellClipboard[0].length
	cellClipboard.forEach((row, dy) => row.forEach((c, dx) => {
		const y = U.y + dy, x = U.x + dx
		if (y < S.canvasHeight && x < S.canvasWidth) S.canvas[y][x] = fitCell(c)
	}))
	// select what was pasted so it can be nudged right away with ⇧H/J/K/L
	U.sel = { start: [U.y, U.x], end: [Math.min(U.y + h, S.canvasHeight) - 1, Math.min(U.x + w, S.canvasWidth) - 1] }
	toast(`Incollato ${w}×${h}${U.x + w > S.canvasWidth || U.y + h > S.canvasHeight ? " (tagliato al bordo)" : ""}`)
}
async function copySvg(msg) {
	const svg = buildSvg()
	try {
		const items = { "text/plain": new Blob([svg], { type: "text/plain" }) }
		if (window.ClipboardItem?.supports?.("image/svg+xml")) items["image/svg+xml"] = new Blob([svg], { type: "image/svg+xml" })
		await navigator.clipboard.write([new ClipboardItem(items)])
	} catch (e) {
		try { await navigator.clipboard.writeText(svg) } catch (e2) { return toast("Copia non riuscita — usa Scarica SVG") }
	}
	toast(typeof msg === "string" ? msg : "Copiato (" + exportInfo + ") — ⌘V in Illustrator")
}
function exportPng() {
	const W = S.canvasWidth * S.cellWidth, H = S.canvasHeight * S.cellHeight, sc = U.exportScale
	const img = new Image(), url = URL.createObjectURL(new Blob([buildSvg(true)], { type: "image/svg+xml" }))
	img.onload = () => {
		const cnv = document.createElement("canvas")
		cnv.width = W * sc; cnv.height = H * sc
		const ctx = cnv.getContext("2d")
		ctx.fillStyle = "#fff"
		ctx.fillRect(0, 0, cnv.width, cnv.height)
		ctx.drawImage(img, 0, 0, cnv.width, cnv.height)
		URL.revokeObjectURL(url)
		cnv.toBlob(b => { download(b, fname() + ".png"); toast("PNG esportato") })
	}
	img.src = url
}

/* ---------- save / load ---------- */
function saveFile(selectionOnly) {
	const st = getState()
	if (selectionOnly) {
		const a = selArea()
		if (!a) return toast("Nessuna selezione")
		const [[sy, sx], [ey, ex]] = a
		st.canvas = fileCanvas(S.canvas.slice(sy, ey + 1).map(r => r.slice(sx, ex + 1)))
		st.canvasWidth = ex - sx + 1
		st.canvasHeight = ey - sy + 1
	}
	download(new Blob([JSON.stringify(st)], { type: "application/json" }), fname() + ".gdc")
}
function readFile(file, cb) {
	const r = new FileReader()
	r.onload = () => {
		try { cb(cleanState(JSON.parse(r.result))) } catch (e) { toast("File non valido: " + e.message) }
	}
	r.readAsText(file)
}
function openDrawing(file) {
	readFile(file, st => {
		act(() => { setState(st); A.deselect() })
		U.fileName = file.name.replace(/\.(gdc|json)$/i, "")
		$("fileName").value = U.fileName
		fit()
		toast("Aperto " + file.name)
	})
}
function placeDrawing(file) {
	readFile(file, st => act(() => st.canvas.forEach((row, dy) => row.forEach((c, dx) => {
		const y = U.y + dy, x = U.x + dx
		if (y < S.canvasHeight && x < S.canvasWidth) S.canvas[y][x] = fitCell(c)
	}))))
}

/* ---------- UI wiring ---------- */
let toastTimer
function toast(msg) {
	const t = $("toast")
	t.textContent = msg
	t.classList.add("show")
	clearTimeout(toastTimer)
	toastTimer = setTimeout(() => t.classList.remove("show"), 1800)
}
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
	document.querySelectorAll(".tabs button, .panel").forEach(el => el.classList.remove("active"))
	b.classList.add("active")
	document.querySelector(`.panel[data-panel="${b.dataset.tab}"]`).classList.add("active")
}))
// buttons should never keep focus, otherwise Space/Enter would re-click them
document.addEventListener("click", e => { if (e.target.closest("button, input[type=checkbox]")) e.target.blur() })
document.addEventListener("change", e => { if (e.target.matches("select, input[type=range]")) e.target.blur() })

const ACTS = {
	rotate: () => A.rotate(false), flip: () => A.flip(false), invert: () => A.invert(false),
	sizeUp: () => A.size(1), sizeDown: () => A.size(-1), sizeCellUp: () => A.size(S.defaultFontSize), sizeCellDown: () => A.size(-S.defaultFontSize),
	offL: () => A.offset(-1, 0), offR: () => A.offset(1, 0), offU: () => A.offset(0, -1), offD: () => A.offset(0, 1),
	glyphReset: A.glyphReset, offsetReset: A.offsetReset,
	colAdd: A.colAdd, colDel: A.colDel, rowAdd: A.rowAdd, rowDel: A.rowDel,
	rowAddAt: A.rowAddAt, rowDelAt: A.rowDelAt, colAddAt: A.colAddAt, colDelAt: A.colDelAt, emptyCanvas: A.emptyCanvas,
	cwUp: () => A.cw(1), cwDown: () => A.cw(-1), chUp: () => A.ch(1), chDown: () => A.ch(-1), fsUp: () => A.fs(1), fsDown: () => A.fs(-1),
}
document.addEventListener("click", e => {
	const b = e.target.closest("[data-act]")
	if (b) return act(ACTS[b.dataset.act])
	const hd = e.target.closest("[data-lhide]")
	if (hd) return act(() => (U.hidden[+hd.dataset.lhide] = !U.hidden[+hd.dataset.lhide]))
	const ly = e.target.closest("[data-layer]")
	if (ly) return act(() => (U.layer = +ly.dataset.layer))
	const sl = e.target.closest("[data-slot]")
	if (sl) {
		const k = sl.dataset.slot, g = K.sets[K.set][k]
		if (U.mapping) return act(() => A.setSlot(k))
		if (g && g[0] !== EMPTY_PATH) { U.glyph = { path: g[0], w: g[1], h: g[2], base: g[3], gid: null }; refreshUI() }
		return
	}
	const g = e.target.closest(".glyphGrid .g")
	if (g) return selectGlyph(+g.dataset.gid)
	const c = e.target.closest("[data-c]")
	if (c) { C.fg = +c.dataset.c; $("quickColor").classList.add("hidden"); refreshUI(); store.set("colors", C) }
})
document.addEventListener("contextmenu", e => {
	const c = e.target.closest("[data-c]")
	if (!c) return
	e.preventDefault()
	C.bg = +c.dataset.c
	refreshUI()
})

$("btnUndo").onclick = () => act(undo)
$("btnRedo").onclick = () => act(redo)
$("btnNew").onclick = () => act(A.emptyCanvas)
$("btnOpen").onclick = $("btnOpen2").onclick = () => $("openFile").click()
$("btnSave").onclick = $("btnSave2").onclick = () => saveFile(false)
$("btnSaveSel").onclick = () => saveFile(true)
$("btnPlace").onclick = () => $("placeFile").click()
$("openFile").onchange = e => { e.target.files[0] && openDrawing(e.target.files[0]); e.target.value = "" }
$("placeFile").onchange = e => { e.target.files[0] && placeDrawing(e.target.files[0]); e.target.value = "" }
$("btnCopySvg").onclick = $("btnCopySvg2").onclick = copySvg
$("btnSvg").onclick = $("btnSvg2").onclick = exportSvg
$("btnPng").onclick = $("btnPng2").onclick = exportPng
$("btnHelp").onclick = () => $("helpModal").classList.remove("hidden")
$("helpClose").onclick = () => $("helpModal").classList.add("hidden")
$("helpModal").onclick = e => e.target.id === "helpModal" && $("helpModal").classList.add("hidden")
$("zoomIn").onclick = () => zoomAt(1.15)
$("zoomOut").onclick = () => zoomAt(1 / 1.15)
$("zoomReset").onclick = fit
$("zoomPct").onclick = () => zoomAt(1 / U.zoom)
$("fileName").oninput = e => (U.fileName = e.target.value)
$("toggleMapping").onchange = e => { U.mapping = e.target.checked; refreshUI() }
$("layerAdd").onclick = () => act(A.addLayer)
$("layerDel").onclick = () => act(A.deleteLayer)
// drag a layer row to reorder (moves the whole layer)
let dragLayer = null
$("layers").addEventListener("dragstart", e => { dragLayer = +e.target.closest("[data-layer]").dataset.layer })
$("layers").addEventListener("dragover", e => e.preventDefault())
$("layers").addEventListener("drop", e => {
	e.preventDefault()
	const t = e.target.closest("[data-layer]")
	if (t && dragLayer !== null) act(() => A.moveLayer(dragLayer, +t.dataset.layer))
	dragLayer = null
})
$("toolPaint").onclick = () => { U.paint = !U.paint; refreshUI() }
$("toolType").onclick = () => { U.typing = !U.typing; typingCheck(); refreshUI() }
function typingCheck() {
	if (U.typing && font && !Typr.U.codeToGlyph(font, 97)) toast(`${fontName} non ha lettere: scegli Unscii, RayMantaC64 o Submona per scrivere`)
}
$("toolGrid").onclick = () => { U.hideGrid = !U.hideGrid; refreshUI() }
$("offsetAmount").oninput = e => (U.offsetAmount = num(e.target.value, 100))
$("dpi").oninput = e => { U.dpi = Math.max(1, num(e.target.value, 150)); refreshUI() }
$("exportScale").oninput = e => { U.exportScale = clamp(num(e.target.value, 5), 1, 25); refreshUI() }
$("fontSelect").onchange = e => { loadFont(e.target.value, e.target.selectedOptions[0].text); $("fontCredits").innerHTML = CREDITS[e.target.value] ? `Font di <a href="${CREDITS[e.target.value]}" target="_blank">${CREDITS[e.target.value]}</a>` : "" }
$("fontFile").onchange = e => { const f = e.target.files[0]; f && f.arrayBuffer().then(b => loadFont(b, f.name)); e.target.value = "" }
$("glyphInvert").onchange = () => font && buildGlyphGrid()
$("glyphJump").onchange = e => { selectGlyph(num(e.target.value, 1) - 1); e.target.blur() }
// glyph sets
$("setAdd").onclick = () => { K.sets.push({}); K.set = K.sets.length - 1; store.set("sets", K); refreshUI() }
$("setDel").onclick = () => { if (K.sets.length < 2) return; K.sets.splice(K.set, 1); K.set = Math.max(0, K.set - 1); store.set("sets", K); refreshUI() }
$("setPrev").onclick = () => { K.set = Math.max(0, K.set - 1); refreshUI() }
$("setNext").onclick = () => { K.set = Math.min(K.sets.length - 1, K.set + 1); refreshUI() }
// colors
const saveColors = () => store.set("colors", { palettes: C.palettes, cohColor: C.cohColor })
$("rgb").innerHTML = ["R", "G", "B"].map((n, i) => `<div class="row"><span class="lbl">${n}</span><input type="range" min="0" max="255" data-ch="${i}" /><input type="number" min="0" max="255" data-ch="${i}" /></div>`).join("")
$("rgb").addEventListener("input", e => {
	const ch = +e.target.dataset.ch, v = clamp(Math.round(num(e.target.value)), 0, 255)
	if (C.editCohesion) C.cohColor[ch] = v
	else palette()[C.fg][ch] = v
	render(); refreshUI(); saveColors()
})
$("editCohesion").onchange = e => { C.editCohesion = e.target.checked; refreshUI() }
$("onlyUsed").onchange = e => { C.onlyUsed = e.target.checked; refreshUI() }
$("brushFg").onchange = e => { C.brushFg = e.target.checked; refreshUI() }
$("brushBg").onchange = e => { C.brushBg = e.target.checked; refreshUI() }
$("cohesion").oninput = e => { C.cohesion = +e.target.value; render(); refreshUI() }
$("palAdd").onclick = () => { C.palettes.push(clone(presets[0].palette)); C.pal = C.palettes.length - 1; saveColors(); render(); refreshUI() }
$("palDel").onclick = () => { if (C.palettes.length < 2) return; C.palettes.splice(C.pal, 1); C.pal = Math.max(0, C.pal - 1); saveColors(); render(); refreshUI() }
$("palPrev").onclick = () => { C.pal = Math.max(0, C.pal - 1); render(); refreshUI() }
$("palNext").onclick = () => { C.pal = Math.min(C.palettes.length - 1, C.pal + 1); render(); refreshUI() }
$("presetSelect").onchange = e => { if (e.target.value === "") return; C.palettes[C.pal] = clone(presets[+e.target.value].palette); saveColors(); render(); refreshUI() }
// drag & drop: .gdc opens a drawing, anything else is tried as a font
document.addEventListener("dragover", e => e.preventDefault())
document.addEventListener("drop", e => {
	e.preventDefault()
	const f = e.dataTransfer.files[0]
	if (!f) return
	if (/\.(gdc|json)$/i.test(f.name)) openDrawing(f)
	else f.arrayBuffer().then(b => loadFont(b, f.name))
})
window.addEventListener("resize", () => render())
new ResizeObserver(() => { const keep = padInk; if (!keep) sizePad() }).observe(pad)

/* ---------- help ---------- */
const MOD = IS_MAC ? "⌘" : "Ctrl+"
const EXP = IS_MAC ? "⌘" : "Ctrl+Alt+"
const HELP = [
	["Movimento", [["Frecce / WASD", "Muovi il cursore"], ["Alt + frecce", "Salta di 5 celle"], ["Clic", "Sposta il cursore", 1], ["Rotella / trackpad", "Sposta la vista", 1], ["Pinch / " + MOD + "rotella", "Zoom", 1], ["+ / −", "Zoom"]]],
	["Disegno", [["Q / Invio", "Disegna il glyph"], ["E / Spazio / Canc", "Cancella"], ["Backspace", "Cancella e torna indietro"], ["Canc / Backspace con selezione", "Svuota l'area", 1], ["R", "Ruota"], ["F", "Specchia"], ["I", "Inverti forma"], ["C", "Copia il glyph dalla cella"], ["[ / ]", "Glyph precedente / successivo", 1], ["{ / }", "Salta di 10 glyph", 1], [", / .", "Layer precedente / successivo"], ["O + frecce", "Sposta il glyph (offset)"], ["G", "Pennello: trascina per disegnare", 1], ["T", "Modalità scrittura (Esc esce)", 1]]],
	["Disegna la forma", [["Disegna nel riquadro", "Mostra i glyph più simili", 1], ["Pausa, poi disegna", "Ricomincia una forma nuova", 1], ["⇧ + disegna", "Aggiunge allo schizzo", 1], ["Clic destro / Alt", "Gomma sullo schizzo", 1], ["← → ↑ ↓", "Scegli tra i risultati", 1], ["Q / Invio", "Disegna la scelta al cursore", 1], ["Tab", "Passa tra risultati e tela", 1], ["[ / ]", "Risultato precedente / successivo", 1]]],
	["Set di glyph", [["M", "Avvia / termina la mappatura"], ["1 – 0", "Assegna (mappatura) o inserisci"]]],
	["Selezione area", [["⇧ + trascina", "Seleziona con il mouse", 1], ["⇧S", "Inizia / blocca selezione"], ["Esc / ⇧D", "Deseleziona"], ["⇧A", "Seleziona tutto"], ["⇧C", "Incolla l'area al cursore"], ["⇧M", "Specchia area"], ["⇧F", "Capovolgi area"], ["⇧Q", "Riempi col glyph"], ["⇧E", "Svuota area"], ["⇧I", "Inverti area"], ["⇧Y", "Ruota i glyph singolarmente"], ["⇧U", "Specchia i glyph singolarmente"], ["⇧R", "Ruota area (quadrata)"], ["⇧T", "Trasponi area (quadrata)"], ["⇧H ⇧J ⇧K ⇧L", "Sposta area ← ↓ ↑ →"]]],
	["Colore", [["X (tieni)", "Palette rapida"], ["V", "Colora primo piano"], ["B", "Colora sfondo"], ["⇧V", "Colora primo piano area"], ["⇧B", "Colora sfondo area"]]],
	["File & export", [[MOD + "Z / " + MOD + "⇧Z", "Annulla / ripeti"], [MOD + "S", "Salva .gdc", 1], [MOD + "O", "Apri .gdc", 1], [MOD + "C / " + MOD + "X", "Copia / taglia l'area (anche per Illustrator)", 1], [MOD + "V", "Incolla l'area al cursore", 1], [MOD + "A", "Seleziona tutto", 1], [EXP + "⇧C", "Copia SVG per Illustrator", 1], [EXP + "E", "Esporta SVG", 1], [EXP + "⇧E", "Esporta PNG", 1], ["H", "Nascondi griglia"], ["P (tieni)", "Anteprima pulita"], ["?", "Questa finestra", 1]]],
]
$("helpBody").innerHTML = HELP.map(([t, rows]) => `<h4>${t}</h4>` + rows.map(([k, d, n]) => `<div class="k"><span><kbd>${k}</kbd></span><span>${d}${n ? '<span class="new">NUOVO</span>' : ""}</span></div>`).join("")).join("")

/* ---------- boot ---------- */
async function boot() {
	presets = await (await fetch("colorPresets.json")).json()
	$("presetSelect").innerHTML += presets.map((p, i) => `<option value="${i}">${p.name}</option>`).join("")
	const col = store.get("colors")
	C.palettes = Array.isArray(col?.palettes) && col.palettes.length ? col.palettes.map(p => Array.from({ length: 256 }, (_, i) => (p[i] || [0, 0, 0]).map(v => clamp(num(v), 0, 255)))) : [clone(presets[0].palette)]
	if (Array.isArray(col?.cohColor)) C.cohColor = col.cohColor.map(v => clamp(num(v), 0, 255))
	const ks = store.get("sets")
	K.sets = Array.isArray(ks?.sets) && ks.sets.length ? ks.sets.map(s => Object.fromEntries(Object.entries(s || {}).filter(([k]) => SLOT_KEYS.includes(k)).map(([k, g]) => [k, cleanLayer(g).slice(0, 4)]))) : [{}]
	try { setState(cleanState(store.get("state"))) } catch (e) { S.canvas = Array.from({ length: S.canvasHeight }, () => Array.from({ length: S.canvasWidth }, () => emptyCell())) }
	history = [stateKey()]
	await loadFont("fonts/Tesserae-TypeDesign.otf", "Tesserae Core")
	render()
	refreshUI()
	fit()
}
boot()

/* ---------- self-check: baked export path must match the editor's matrix ---------- */
;(() => {
	const m = [2, 0, 0, -3, 10, 20]
	const sq = "M0 0L0 10L10 10L10 0Z" // negative signed area in this convention → gets reversed
	console.assert(bakePath(sq, [1, 0, 0, 1, 0, 0]) === "M10 0L10 10L0 10L0 0Z", "bakePath reverse", bakePath(sq, [1, 0, 0, 1, 0, 0]))
	console.assert(bakePath(sq, [1, 0, 0, -1, 0, 10]) === "M0 10L0 0L10 0L10 10Z", "bakePath mirrored keeps", bakePath(sq, [1, 0, 0, -1, 0, 10]))
	console.assert(bakePath("M0 0L1 1Q2 2 3 3Z", m).startsWith("M"), "bakePath curves")
	console.assert(JSON.stringify(mul(T(1, 2), Sc(2))) === "[2,0,0,2,1,2]", "mul")
})()
