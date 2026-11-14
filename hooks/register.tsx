import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Snapshot, TodoList } from '../types'
import { localDay, parseLists, parseTasks } from './parse'

const PANE = 'todo'
const SERVER = 'microsoft-todo'
const snapshot = atom({ plugin: 'todo-pane', key: 'snapshot' } as const, null, { shape: 'snap-1' })
const openList = atom({ plugin: 'todo-pane', key: 'openList' } as const, null)
const busy = atom({ plugin: 'todo-pane', key: 'busy' } as const, false)

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map(c => c.text ?? '').join('\n')

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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const open = await read($, openList)
    const isBusy = await read($, busy)
    const today = localDay(await $.clock.now())

    const complete = async (listId: string, taskId: string) => {
      const r = await $.mcp.call(SERVER, 'update-task', { listId, taskId, status: 'completed' })
      if (r.isError) return $.ui.toast('Could not complete: ' + textOf(r).slice(0, 80))
      await update($, snapshot, s => s && {
        ...s,
        lists: s.lists.map(l => (l.id === listId ? { ...l, tasks: l.tasks.filter(t => t.id !== taskId) } : l)),
      })
    }

    const row = (listId: string, t: { id: string; title: string; due: string | null; isHigh: boolean }, listName?: string) => {
      const late = t.due !== null && t.due < today
      const meta = [t.due && (t.due === today ? 'Today' : shortDate(t.due)), listName].filter(Boolean).join(' · ')
      return (
        <Box key={'row-' + t.id} gap={1} paddingY={1} alignItems="flex-start" hover={{ backgroundColor: 'subtle' }}>
          <Button key={'done-' + t.id} label="○" plain dimColor onPress={() => complete(listId, t.id)} />
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
    const time = snap.at ? new Date(snap.at).toTimeString().slice(0, 5) : '—'

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text size="caption" dimColor>{isBusy ? 'Refreshing…' : `${all.length} open · ${time}`}</Text>
          <Button key="refresh" label="↻" plain dimColor onPress={() => refresh($)} />
        </Box>
        {snap.error && <Text dimColor>Tap ↻ once to connect to To Do.</Text>}

        {urgent.length > 0 && head('Overdue / today', urgent.length)}
        {urgent.map(x => row(x.l.id, x.t, x.l.name))}

        {high.length > 0 && head('Important', high.length)}
        {high.map(x => row(x.l.id, x.t, x.l.name))}

        {head('Lists', snap.lists.length)}
        {snap.lists.map(l => (
          <Box key={'box-' + l.id} flexDirection="column">
            <Button key={'list-' + l.id} plain onPress={() => update($, openList, cur => (cur === l.id ? null : l.id))}>
              {open === l.id ? '▾ ' : '▸ '}{l.name} <Text dimColor>{String(l.tasks.length)}</Text>
            </Button>
            {open === l.id && <Box flexDirection="column" paddingLeft={2}>{l.tasks.map(t => row(l.id, t))}</Box>}
          </Box>
        ))}
      </Box>
    )
  })
}
