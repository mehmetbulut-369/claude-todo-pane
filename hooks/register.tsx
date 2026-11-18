import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { BoardMsg, Order, Row, Snapshot, Task, TodoList } from '../types'
import { byOrder, isCut, localDay, parseChecklist, parseLists, parseTasks, place } from './parse'

const PANE = 'todo'
const SERVER = 'microsoft-todo'
const snapshot = atom({ plugin: 'todo-pane', key: 'snapshot' } as const, null, { shape: 'snap-1' })
const openList = atom({ plugin: 'todo-pane', key: 'openList' } as const, null)
const busy = atom({ plugin: 'todo-pane', key: 'busy' } as const, false)
const order = atom({ plugin: 'todo-pane', key: 'order' } as const, { lists: [], tasks: {} } as Order)
// shortcut: module state, so a reload mid-move forgets the lock; fine for one person's pane.
let working = false

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map(c => c.text ?? '').join('\n')
// The server reports failures as ordinary text ("Failed to…", "Error …"), not as isError.
const ok = (r: { isError?: boolean; content: { type: string; text?: string }[] }) =>
  !r.isError && /successfully/.test(textOf(r))

// Lists and their tasks in the order the person dragged them into.
const ordered = (snap: Snapshot, o: Order): TodoList[] =>
  byOrder(snap.lists, o.lists).map(l => ({ ...l, tasks: byOrder(l.tasks, o.tasks[l.id]) }))

async function saveOrder($: Engine, fn: (o: Order, lists: TodoList[]) => Order) {
  const snap = await read($, snapshot)
  if (!snap) return
  const next = fn(await read($, order), ordered(snap, await read($, order)))
  await update($, order, () => next)
  await $.store.set('order', next)
}

async function complete($: Engine, listId: string, taskId: string) {
  const r = await $.mcp.call(SERVER, 'update-task', { listId, taskId, status: 'completed' })
  if (!ok(r)) return $.ui.toast('Could not complete: ' + textOf(r).slice(0, 80))
  await dropTask($, listId, taskId)
}

const dropTask = ($: Engine, listId: string, taskId: string) =>
  update($, snapshot, s => s && {
    ...s,
    lists: s.lists.map(l => (l.id === listId ? { ...l, tasks: l.tasks.filter(t => t.id !== taskId) } : l)),
  })

// Graph cannot move a task between lists, so a move is copy (with its steps) then delete.
// Nothing is deleted unless the copy is whole; a failed copy is removed again.
async function moveTask($: Engine, t: Task, from: string, to: string, before: string | null) {
  if (isCut(t.desc)) return $.ui.toast('This task has a long note that would be cut. Move it in To Do instead.')
  const steps = parseChecklist(textOf(await $.mcp.call(SERVER, 'get-checklist-items', { listId: from, taskId: t.id })))
  if (!steps) return $.ui.toast('Could not read its steps, so nothing was moved.')
  const made = await $.mcp.call(SERVER, 'create-task', {
    listId: to,
    title: t.title,
    importance: t.isHigh ? 'high' : 'normal',
    ...(t.due && { dueDateTime: t.due + 'T00:00:00' }),
    ...(t.desc && { body: t.desc }),
    ...(t.cats.length > 0 && { categories: t.cats }),
  })
  const id = /ID: (\S+)/.exec(textOf(made))?.[1]
  if (!ok(made) || !id) return $.ui.toast('Could not move: ' + textOf(made).slice(0, 80))
  for (const c of steps) {
    const r = await $.mcp.call(SERVER, 'create-checklist-item', { listId: to, taskId: id, displayName: c.name, isChecked: c.isChecked })
    if (!ok(r)) {
      await $.mcp.call(SERVER, 'delete-task', { listId: to, taskId: id })
      return $.ui.toast('Could not copy its steps, so nothing was moved.')
    }
  }
  const del = await $.mcp.call(SERVER, 'delete-task', { listId: from, taskId: t.id })
  if (!ok(del)) $.ui.toast('Copied, but the original could not be removed. Delete it in To Do.')
  else await dropTask($, from, t.id)
  await update($, snapshot, s => s && {
    ...s,
    lists: s.lists.map(l => (l.id === to ? { ...l, tasks: [{ ...t, id }, ...l.tasks] } : l)),
  })
  await saveOrder($, (o, lists) => ({
    ...o,
    tasks: { ...o.tasks, [to]: place(lists.find(l => l.id === to)?.tasks.map(x => x.id) ?? [], id, before) },
  }))
}

// Dropping a task on another task makes it a step there; the task itself is completed, not deleted.
async function intoTask($: Engine, t: Task, from: string, toList: string, to: string, toTitle: string) {
  const r = await $.mcp.call(SERVER, 'create-checklist-item', { listId: toList, taskId: to, displayName: t.title })
  if (!ok(r)) return $.ui.toast('Could not add it as a step: ' + textOf(r).slice(0, 80))
  const c = await $.mcp.call(SERVER, 'update-task', { listId: from, taskId: t.id, status: 'completed' })
  if (!ok(c)) return $.ui.toast('Added as a step, but the task itself is still open.')
  await dropTask($, from, t.id)
  $.ui.toast(`"${t.title}" is now a step of "${toTitle}".`)
}

async function act($: Engine, m: BoardMsg) {
  if (m.op === 'toggle') return update($, openList, cur => (cur === m.listId ? null : m.listId))
  if (m.op === 'reorderList') return saveOrder($, (o, lists) => ({ ...o, lists: place(lists.map(l => l.id), m.id, m.before) }))
  if (m.op === 'reorderTask') {
    return saveOrder($, (o, lists) => ({
      ...o,
      tasks: { ...o.tasks, [m.listId]: place(lists.find(l => l.id === m.listId)?.tasks.map(t => t.id) ?? [], m.id, m.before) },
    }))
  }
  const snap = await read($, snapshot)
  const find = (listId: string, id: string) => snap?.lists.find(l => l.id === listId)?.tasks.find(t => t.id === id)
  const t = find(m.listId, m.id)
  if (!t) return
  if (working) return $.ui.toast('Still working on the last move…')
  working = true
  try {
    if (m.op === 'complete') await complete($, m.listId, m.id)
    if (m.op === 'move') await moveTask($, t, m.listId, m.toList, m.before)
    if (m.op === 'into') await intoTask($, t, m.listId, m.toList, m.to, find(m.toList, m.to)?.title ?? 'that task')
  } finally {
    working = false
  }
}

async function refresh($: Engine) {
  if (await read($, busy)) return
  await update($, busy, () => true)
  let snap: Snapshot
  try {
    const res = await $.mcp.call(SERVER, 'get-task-lists')
    // An error here (e.g. expired sign-in) must not look like an account with no tasks.
    if (res.isError) throw new Error(textOf(res))
    const lists = parseLists(textOf(res))
    const filled: TodoList[] = await Promise.all(
      lists.map(async l => {
        const r = await $.mcp.call(SERVER, 'get-tasks', { listId: l.id, filter: "status ne 'completed'", top: 100 })
        return { ...l, tasks: r.isError ? [] : parseTasks(textOf(r)) }
      }),
    )
    snap = { lists: filled.filter(l => l.tasks.length > 0), at: await $.clock.now(), error: null }
  } catch (err) {
    const prev = await read($, snapshot)
    snap = { lists: prev?.lists ?? [], at: prev?.at ?? 0, error: String((err as Error)?.message ?? err) }
  }
  await update($, snapshot, () => snap)
  await update($, busy, () => false)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'todo', description: 'Open the Microsoft To Do pane' })
    // A saved order is a convenience: if it can't be read, the pane still opens in To Do's order.
    const saved = (await $.store.get('order').catch(() => undefined)) as Order | undefined
    if (saved?.lists && saved.tasks) await update($, order, () => saved)
    void $.ui.open({ id: PANE, title: 'To Do' })
    void refresh($)
    $.clock.every(5 * 60_000, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'todo' }, async $ => {
    await $.ui.open({ id: PANE, title: 'To Do' })
    void refresh($)
    return { text: 'To Do pane opened.' }
  })

  on('ui.message', async ($, e, next) => {
    const m = e.data as BoardMsg | null
    if (e.element !== 'board' || typeof m?.op !== 'string') return next(e)
    void act($, m) // a move takes several calls; don't hold the hook while it runs
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const snap = await read($, snapshot)
    const open = await read($, openList)
    const isBusy = await read($, busy)
    const today = localDay(await $.clock.now())

    const done = (listId: string, taskId: string) => act($, { op: 'complete', listId, id: taskId })

    const row = (listId: string, t: { id: string; title: string; due: string | null; isHigh: boolean }, listName?: string) => {
      const late = t.due !== null && t.due < today
      const meta = [t.due && (t.due === today ? 'Today' : shortDate(t.due)), listName].filter(Boolean).join(' · ')
      return (
        <Box key={'row-' + t.id} gap={1} paddingY={1} alignItems="flex-start" hover={{ backgroundColor: 'subtle' }}>
          <Button key={'done-' + t.id} label="○" plain dimColor onPress={() => done(listId, t.id)} />
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text wrap="wrap">{t.title}</Text>
            {meta && <Text size="caption" color={late ? 'error' : t.due === today ? 'suggestion' : 'inactive'}>{meta}</Text>}
          </Box>
          {t.isHigh && <Text color="suggestion">★</Text>}
        </Box>
      )
    }
    const head = (label: string, n: number) => (
      <Box key={'h-' + label} justifyContent="space-between" marginTop={1}>
        <Text weight="semibold">{label}</Text>
        <Text dimColor tabular>{String(n)}</Text>
      </Box>
    )

    if (!snap) return <Text dimColor>{isBusy ? 'Loading tasks…' : 'No data yet.'}</Text>

    const all = snap.lists.flatMap(l => l.tasks.map(t => ({ l, t })))
    const urgent = all.filter(x => x.t.due && x.t.due <= today).sort((a, b) => a.t.due!.localeCompare(b.t.due!))
    const high = all.filter(x => x.t.isHigh && !(x.t.due && x.t.due <= today))
    const lists = ordered(snap, await read($, order))
    const tone = (due: string | null): 'error' | 'suggestion' | 'inactive' => (due === null ? 'inactive' : due < today ? 'error' : due === today ? 'suggestion' : 'inactive')
    const task = (sec: string, l: TodoList, t: Task, withList: boolean): Row => ({
      kind: 'task', key: sec + '-' + t.id, id: t.id, listId: l.id, title: t.title, isHigh: t.isHigh, tone: tone(t.due),
      meta: [t.due && (t.due === today ? 'Today' : shortDate(t.due)), withList && l.name].filter(Boolean).join(' · '),
    })
    const section = (key: string, label: string, xs: { l: TodoList; t: Task }[]): Row[] =>
      xs.length === 0 ? [] : [{ kind: 'section', key, label, n: xs.length }, ...xs.map(x => task(key, x.l, x.t, true))]
    const rows: Row[] = [
      ...section('urgent', 'Overdue / today', urgent),
      ...section('high', 'Important', high),
      { kind: 'section', key: 'lists', label: 'Lists', n: lists.length },
      ...lists.flatMap(l => [
        { kind: 'list' as const, key: 'l-' + l.id, id: l.id, name: l.name, n: l.tasks.length, open: open === l.id },
        ...(open === l.id ? l.tasks.map(t => task('in', l, t, false)) : []),
      ]),
    ]
    const time = snap.at ? new Date(snap.at).toTimeString().slice(0, 5) : '—'

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text size="caption" dimColor>{isBusy ? 'Refreshing…' : `${all.length} open · ${time}`}</Text>
          <Button key="refresh" label="↻" plain dimColor onPress={() => refresh($)} />
        </Box>
        {snap.error && <Text dimColor>Tap ↻ once to connect to To Do.</Text>}

        {'Client' in els ? (
          // One board for every section: drag rows to reorder, onto a list to move, hold on a task to make it a step.
          <els.Client key="board" module="./board.tsx" props={{ rows }} width="100%" />
        ) : (
          <>
            {urgent.length > 0 && head('Overdue / today', urgent.length)}
            {urgent.map(x => row(x.l.id, x.t, x.l.name))}

            {high.length > 0 && head('Important', high.length)}
            {high.map(x => row(x.l.id, x.t, x.l.name))}

            {head('Lists', snap.lists.length)}
            {lists.map(l => (
              <Box key={'box-' + l.id} flexDirection="column">
                <Button key={'list-' + l.id} plain onPress={() => update($, openList, cur => (cur === l.id ? null : l.id))}>
                  {open === l.id ? '▾ ' : '▸ '}{l.name} <Text dimColor>{String(l.tasks.length)}</Text>
                </Button>
                {open === l.id && <Box flexDirection="column" paddingLeft={2}>{l.tasks.map(t => row(l.id, t))}</Box>}
              </Box>
            ))}
          </>
        )}
      </Box>
    )
  })
}
