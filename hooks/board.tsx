import type { ClientModule, ClientPointerEvent } from 'claude-code'

import type { BoardMsg, BoardProps, Row } from '../types'

// The board draws one row per line, so the pointer's row is an index into what is drawn.
type Drag = { from: number; y: number; x0: number; y0: number; moved: boolean; still: number }
type Live = { p: BoardProps; st: S }
type S = { cur: number; drag: Drag | null; live: Live }

const TICK = 150
const DWELL = 4 // ticks a dragged task rests on another task before it drops *into* it (600 ms)

const clamp = (rows: Row[], y: number, lo = 0) => Math.max(lo, Math.min(rows.length - 1, y))
// A task always lands below some list header, so never at row 0.
const taskY = (rows: Row[], y: number) => clamp(rows, y, 1)
// The list a row belongs to; '' under a section (Overdue, Important), where a drop means nothing.
const listAt = (rows: Row[], y: number) => {
  for (let i = y; i >= 0; i--) {
    const r = rows[i]
    if (r?.kind === 'list') return r.id
    if (r?.kind === 'section') return ''
  }
  return ''
}
// The rows as they would stand if the dragged row were let go at y.
const preview = (rows: Row[], from: number, y: number) => {
  const r = rows.slice()
  const [d] = r.splice(from, 1)
  if (d) r.splice(y, 0, d)
  return r
}
// A dragged task held still on another task: let go now, it becomes that task's step.
const intoOf = (rows: Row[], d: Drag) => {
  const t = rows[d.y]
  const f = rows[d.from]
  return d.moved && d.still >= DWELL && t?.kind === 'task' && f?.kind === 'task' && t.id !== f.id ? t : null
}

export function dropOf(rows: Row[], d: Drag): BoardMsg | null {
  const r = rows[d.from]
  if (!r || r.kind === 'section') return null
  if (r.kind === 'list') {
    const ids = rows.filter(x => x.kind === 'list').map(x => x.id)
    const fi = ids.indexOf(r.id)
    const ti = ids.indexOf(listAt(rows, clamp(rows, d.y)))
    if (ti < 0 || ti === fi) return null
    const next = ids.filter(x => x !== r.id)
    next.splice(ti, 0, r.id)
    return { op: 'reorderList', id: r.id, before: next[ti + 1] ?? null }
  }
  const into = intoOf(rows, d)
  if (into?.kind === 'task') return { op: 'into', listId: r.listId, id: r.id, toList: into.listId, to: into.id }
  const y = taskY(rows, d.y)
  if (y === d.from) return null
  const v = preview(rows, d.from, y)
  const list = listAt(v, y - 1)
  if (!list) return null
  const after = v[y + 1]
  const before = after?.kind === 'task' ? after.id : null
  return list === r.listId
    ? { op: 'reorderTask', listId: r.listId, id: r.id, before }
    : { op: 'move', listId: r.listId, id: r.id, toList: list, before }
}

const clickOf = (r: Row | undefined, x: number): BoardMsg | null =>
  !r || r.kind === 'section' ? null : r.kind === 'list' ? { op: 'toggle', listId: r.id } : x <= 3 ? { op: 'complete', listId: r.listId, id: r.id } : null

const Board: ClientModule<BoardProps, S> = (p, s) => {
  const { Box, Text } = s.elements
  const first = !s.state
  const st: S = s.state ?? { cur: -1, drag: null, live: { p, st: undefined as unknown as S } }
  const live = st.live
  live.p = p
  live.st = st
  const set = (n: Partial<S>) => {
    live.st = { ...live.st, ...n }
    s.setState(live.st)
  }

  if (first) {
    s.every(TICK, () => {
      const d = live.st.drag
      if (d?.moved && d.still < DWELL) set({ drag: { ...d, still: d.still + 1 } })
    })
    s.onPointer((ev: ClientPointerEvent) => {
      const rows = live.p.rows
      const d = live.st.drag
      if (ev.type === 'down') {
        if (ev.button !== 'left' || ev.y < 0 || ev.y >= rows.length) return
        return set({ cur: -1, drag: { from: ev.y, y: ev.y, x0: ev.x, y0: ev.y, moved: false, still: 0 } })
      }
      if (!d) return
      if (ev.type === 'move') {
        const y = clamp(rows, ev.y)
        const moved = d.moved || ev.y !== d.y0 || Math.abs(ev.x - d.x0) >= 2
        if (y !== d.y || moved !== d.moved) set({ drag: { ...d, y, moved, still: y === d.y ? d.still : 0 } })
      } else if (ev.type === 'up') {
        set({ drag: null })
        const msg = d.moved ? dropOf(rows, d) : clickOf(rows[d.from], ev.x)
        if (msg) s.post(msg)
      }
    })
    // Keyboard: ↑↓ walk the rows, shift+↑↓ moves the row, return opens a list, space completes a task.
    s.onKey(k => {
      const rows = live.p.rows
      const cur = live.st.cur
      const r = rows[cur]
      if (k.key === 'up' || k.key === 'down') {
        const dy = k.key === 'up' ? -1 : 1
        if (!k.shift || !r || r.kind === 'section') return set({ cur: clamp(rows, cur + dy) })
        // A list jumps a whole list: aim at the neighbouring header, not at its own tasks.
        let y = cur + dy
        if (r.kind === 'list') while (rows[y] && rows[y]?.kind !== 'list') y += dy
        const msg = dropOf(rows, { from: cur, y, x0: 0, y0: cur, moved: true, still: 0 })
        if (msg && (msg.op === 'reorderTask' || msg.op === 'reorderList')) s.post(msg)
        if (msg?.op === 'reorderTask') set({ cur: cur + dy })
        return
      }
      if (k.key === 'return' && r?.kind === 'list') s.post({ op: 'toggle', listId: r.id })
      if ((k.key === ' ' || k.key === 'space') && r?.kind === 'task') s.post({ op: 'complete', listId: r.listId, id: r.id })
    })
  }

  const d = st.drag
  const dragged = d?.moved ? p.rows[d.from] : null
  const into = d ? intoOf(p.rows, d) : null
  const target = dragged?.kind === 'list' ? listAt(p.rows, clamp(p.rows, d!.y)) : null
  // Rows make room only where letting go would do something.
  const view = dragged?.kind === 'task' && !into && dropOf(p.rows, d!) ? preview(p.rows, d!.from, taskY(p.rows, d!.y)) : p.rows

  return (
    <Box flexDirection="column" width="100%">
      {view.map((r, i) => {
        const lit = r === dragged || r === into || (r.kind === 'list' && r.id === target) || (!d && i === st.cur)
        return (
          <Box key={'r-' + r.key} height={1} gap={1} justifyContent={r.kind === 'section' ? 'space-between' : undefined} backgroundColor={lit ? 'subtle' : undefined}>
            {r.kind === 'section' ? (
              <>
                <Text weight="semibold">{r.label}</Text>
                <Text dimColor>{String(r.n)}</Text>
              </>
            ) : r.kind === 'list' ? (
              <>
                <Text key={'t-' + r.key} weight="semibold" wrap="truncate-end">{(r.open ? '▾ ' : '▸ ') + r.name}</Text>
                <Text dimColor>{String(r.n)}</Text>
              </>
            ) : (
              <>
                <Text dimColor>{'  ○'}</Text>
                <Text key={'t-' + r.key} wrap="truncate-end">{r.title}</Text>
                {r === into && <Text color="suggestion">+ step</Text>}
                {r.meta && <Text color={r.tone} wrap="truncate-end">{r.meta}</Text>}
                {r.isHigh && <Text color="suggestion">★</Text>}
              </>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export default Board
