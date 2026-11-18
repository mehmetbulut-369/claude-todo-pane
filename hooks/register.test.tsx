import { expect, mock, test } from 'claude-code/testing'
import { byOrder, isCut, localDay, parseChecklist, parseLists, parseTasks, place } from './parse'

const PANE = {
  plugin: 'todo-pane', component: 'Pane', requestId: 'todo',
  props: { title: 'To Do', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const text = (t: string) => ({ value: { content: [{ type: 'text', text: t }], isError: false } })

test('parser', async () => {
  expect(parseLists('ID: a1\nName: Tasks (Default Tasks List)\n---\nID: b2\nName: TR\n---')).toEqual([
    { id: 'a1', name: 'Tasks' }, { id: 'b2', name: 'TR' },
  ])
  expect(parseTasks('○ ID: x\nTitle: A task\nDue: 11/5/2026\nImportance: high\nCategories: Red, Blue\nDescription: a note\n---\n✓ ID: y\nTitle: Bitti\n---\n○ ID: z\nTitle: Other\n---')).toEqual([
    { id: 'x', title: 'A task', due: '2026-11-05', isHigh: true, desc: 'a note', cats: ['Red', 'Blue'] },
    { id: 'z', title: 'Other', due: null, isHigh: false, desc: null, cats: [] },
  ])
  expect(parseChecklist('Checklist items for task "T" (ID: t):\n\n✓ Buy (ID: c1)\nCreated: x\n\n○ Pay (ID: c2)')).toEqual([
    { name: 'Buy', isChecked: true }, { name: 'Pay', isChecked: false },
  ])
  expect(parseChecklist('No checklist items found for task "T" (ID: t)')).toEqual([])
  expect(parseChecklist('Error fetching checklist items: boom')).toBe(null)
  expect(isCut('x'.repeat(50) + '...')).toBe(true)
  expect(isCut('short note')).toBe(false)
})

test('order helpers', async () => {
  expect(place(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  expect(place(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
  // a task To Do added since the order was saved shows first
  expect(byOrder([{ id: 'a' }, { id: 'n' }, { id: 'b' }], ['b', 'a']).map(x => x.id)).toEqual(['n', 'b', 'a'])
})

test('today is the local date, not the UTC date', async () => {
  // 00:30 local time: in Germany (UTC+1) the UTC date is still the day before
  expect(localDay(new Date(2026, 10, 14, 0, 30).getTime())).toBe('2026-11-14')
  expect(localDay(new Date(2026, 10, 14, 23, 59).getTime())).toBe('2026-11-14')
})

test('pane shows overdue and completes a task', async ($, on) => {
  const calls: string[] = []
  mock.store(on)
  on('command.register', () => ({ value: { command: 'todo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-13T10:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('mcp.call', (_, e: any) => {
    calls.push(e.tool)
    if (e.tool === 'get-task-lists') return text('ID: L1\nName: TR\n---')
    // like the real server: a completed task no longer comes back
    if (e.tool === 'get-tasks') return text(calls.includes('update-task') ? 'No tasks found' : '○ ID: t1\nTitle: Pay tax\nDue: 11/1/2026\nImportance: normal\n---')
    return text('Task updated successfully!')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // rows: Overdue / today, Pay tax, Lists, TR; the ○ sits at the row's start
  expect((await ui.find({ type: 'Text', text: /Pay tax/, in: 'board' }))?.text).toContain('Pay tax')
  await ui.pointer({ type: 'down', x: 2, y: 1, button: 'left', in: 'board' })
  await ui.pointer({ type: 'up', x: 2, y: 1, button: 'left', in: 'board' })
  expect(calls).toContain('update-task')
  expect(await ui.find({ type: 'Text', text: /Pay tax/, in: 'board' })).toBeFalsy()
  await ui.unmount()
})

// A fake To Do server whose behaviour each test can switch while the pane is open.
function fakeServer(on: any, store: Record<string, unknown> = {}) {
  mock.store(on, store)
  const state = { mode: 'ok' as 'ok' | 'throw' | 'listsError' | 'oneListError', l1: '○ ID: t1\nTitle: Pay tax\n---', calls: [] as { tool: string; args: any }[], toasts: [] as string[], gone: new Set<string>() }
  on('ui.toast', (_: any, e: any) => { state.toasts.push(e.text ?? JSON.stringify(e)); return { value: undefined } })
  on('command.register', () => ({ value: { command: 'todo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-13T10:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('mcp.call', (_: any, e: any) => {
    state.calls.push({ tool: e.tool, args: e.args })
    // like the real server: completed or deleted tasks no longer come back
    if (e.tool === 'update-task' || e.tool === 'delete-task') state.gone.add(e.args.taskId)
    if (state.mode === 'throw') throw new Error('MCP server microsoft-todo is not connected')
    if (e.tool === 'get-task-lists') {
      if (state.mode === 'listsError') return { value: { content: [{ type: 'text', text: 'Authentication expired' }], isError: true } }
      return text('ID: L1\nName: TR\n---\nID: L2\nName: Home\n---')
    }
    if (e.tool === 'get-tasks') {
      if (state.mode === 'oneListError' && e.args?.listId === 'L1') return { value: { content: [{ type: 'text', text: 'boom' }], isError: true } }
      const all = e.args?.listId === 'L1' ? state.l1 : '○ ID: t2\nTitle: Buy milk\n---'
      return text(all.split('\n---').filter(b => ![...state.gone].some(id => b.includes('ID: ' + id + '\n'))).join('\n---'))
    }
    // the real server's success lines
    if (e.tool === 'get-checklist-items') return text('Checklist items for task "Pay tax" (ID: t1):\n\n○ Find form (ID: c1)')
    if (e.tool === 'create-task') return text('Task created successfully!\nID: n1\nTitle: ' + e.args.title)
    if (e.tool === 'create-checklist-item') return text('Checklist item created successfully!\nContent: x\nID: c9')
    if (e.tool === 'delete-task') return text('Task with ID: x was successfully deleted from list: y')
    if (e.tool === 'update-task') return text('Task updated successfully!\nID: x\nTitle: y')
    return text('ok')
  })
  return state
}

const shows = async (ui: any, re: RegExp) =>
  Boolean((await ui.find({ type: 'Text', text: re })) ?? (await ui.find({ type: 'Text', text: re, in: 'board' })))
// The board's rows, top to bottom, as their main text.
const rows = async (ui: any) =>
  (await ui.findAll({ type: 'Text', in: 'board' })).map((t: any) => t.text).filter((t: string) => /^[▸▾] |^[A-Z]/.test(t))
const drag = async (ui: any, from: number, to: number, holdMs = 0) => {
  await ui.pointer({ type: 'down', x: 8, y: from, button: 'left', in: 'board' })
  await ui.pointer({ type: 'move', x: 8, y: to, in: 'board' })
  if (holdMs) await ui.advance(holdMs)
  await ui.pointer({ type: 'up', x: 8, y: to, button: 'left', in: 'board' })
}
const click = async (ui: any, y: number, x = 8) => {
  await ui.pointer({ type: 'down', x, y, button: 'left', in: 'board' })
  await ui.pointer({ type: 'up', x, y, button: 'left', in: 'board' })
}

test('a failed refresh keeps the last good list and asks for a refresh', async ($, on) => {
  const server = fakeServer(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shows(ui, /Home/)).toBe(true)

  server.mode = 'throw'
  await ui.press({ key: 'refresh' })
  expect(await shows(ui, /Tap ↻ once/)).toBe(true)
  expect(await shows(ui, /Home/)).toBe(true)

  server.mode = 'ok'
  await ui.press({ key: 'refresh' })
  expect(await shows(ui, /Tap ↻ once/)).toBe(false)
  await ui.unmount()
})

test('an error on the list call is a failed refresh, not an empty account', async ($, on) => {
  const server = fakeServer(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shows(ui, /Home/)).toBe(true)

  server.mode = 'listsError'
  await ui.press({ key: 'refresh' })
  expect(await shows(ui, /Tap ↻ once/)).toBe(true)
  expect(await shows(ui, /Home/)).toBe(true)
  await ui.unmount()
})

test('one failing list does not hide the others', async ($, on) => {
  const server = fakeServer(on)
  server.mode = 'oneListError'
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shows(ui, /Home/)).toBe(true)
  expect(await shows(ui, /^. TR$/)).toBe(false)
  await ui.unmount()
})

const open = async ($: any, on: any) => {
  const server = fakeServer(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return { server, ui: await $.ui.mount({ ...PANE, surface: 'desktop' }) }
}

test('dragging a list header reorders the lists and keeps the order', async ($, on) => {
  const { ui } = await open($, on)
  expect(await rows(ui)).toEqual(['Lists', '▸ TR', '▸ Home'])
  await drag(ui, 2, 1)
  expect(await rows(ui)).toEqual(['Lists', '▸ Home', '▸ TR'])
  await ui.unmount()
})

test('a saved order is used when the pane opens', async ($, on) => {
  const server = fakeServer(on, { order: { lists: ['L2', 'L1'], tasks: {} } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await rows(ui)).toEqual(['Lists', '▸ Home', '▸ TR'])
  expect(server.calls.length).toBeGreaterThan(0)
  await ui.unmount()
})

test('dragging a task onto another list moves it with its steps, then removes the original', async ($, on) => {
  const { server, ui } = await open($, on)
  await click(ui, 1) // open TR: rows are Lists, TR, Pay tax, Home
  expect(await rows(ui)).toEqual(['Lists', '▾ TR', 'Pay tax', '▸ Home'])
  await drag(ui, 2, 3)
  const tools = server.calls.map(c => c.tool).filter(t => !t.startsWith('get-task'))
  expect(tools).toEqual(['get-checklist-items', 'create-task', 'create-checklist-item', 'delete-task'])
  expect(server.calls.find(c => c.tool === 'create-task')?.args).toMatchObject({ listId: 'L2', title: 'Pay tax' })
  expect(server.calls.find(c => c.tool === 'delete-task')?.args).toEqual({ listId: 'L1', taskId: 't1' })
  await ui.unmount()
})

test('a task whose note would be cut is not moved', async ($, on) => {
  const { server, ui } = await open($, on)
  server.l1 = '○ ID: t1\nTitle: Pay tax\nDescription: ' + 'x'.repeat(50) + '...\n---'
  await ui.press({ key: 'refresh' })
  await click(ui, 1)
  await drag(ui, 2, 3)
  expect(server.calls.some(c => c.tool === 'create-task' || c.tool === 'delete-task')).toBe(false)
  await ui.unmount()
})

test('holding a task on another task makes it a step and completes it, deleting nothing', async ($, on) => {
  const { server, ui } = await open($, on)
  server.l1 = '○ ID: t1\nTitle: Pay tax\n---\n○ ID: t3\nTitle: Tax return\n---'
  await ui.press({ key: 'refresh' })
  await click(ui, 1)
  expect(await rows(ui)).toEqual(['Lists', '▾ TR', 'Pay tax', 'Tax return', '▸ Home'])
  await drag(ui, 2, 3, 700)
  expect(server.calls.find(c => c.tool === 'create-checklist-item')?.args).toEqual({ listId: 'L1', taskId: 't3', displayName: 'Pay tax' })
  expect(server.calls.find(c => c.tool === 'update-task')?.args).toMatchObject({ listId: 'L1', taskId: 't1', status: 'completed' })
  expect(server.calls.some(c => c.tool === 'delete-task')).toBe(false)
  expect(server.toasts).toEqual(['"Pay tax" is now a step of "Tax return".'])
  expect(await rows(ui)).toEqual(['Lists', '▾ TR', 'Tax return', '▸ Home'])
  await ui.unmount()
})

test('a quick drag within a list only reorders it, in the pane', async ($, on) => {
  const { server, ui } = await open($, on)
  server.l1 = '○ ID: t1\nTitle: Pay tax\n---\n○ ID: t3\nTitle: Tax return\n---'
  await ui.press({ key: 'refresh' })
  await click(ui, 1)
  await drag(ui, 2, 3)
  expect(await rows(ui)).toEqual(['Lists', '▾ TR', 'Tax return', 'Pay tax', '▸ Home'])
  expect(server.calls.some(c => !c.tool.startsWith('get-task'))).toBe(false)
  await ui.unmount()
})

test('without a mouse: arrows walk, shift+arrow moves, return opens', async ($, on) => {
  const { ui } = await open($, on)
  await ui.key({ key: 'down', in: 'board' }) // Lists
  await ui.key({ key: 'down', in: 'board' }) // TR
  await ui.key({ key: 'down', shift: true, in: 'board' })
  expect(await rows(ui)).toEqual(['Lists', '▸ Home', '▸ TR'])
  await ui.key({ key: 'down', in: 'board' })
  await ui.key({ key: 'return', in: 'board' })
  expect(await rows(ui)).toEqual(['Lists', '▸ Home', '▾ TR', 'Pay tax'])
  await ui.unmount()
})

test('an overdue task can be dragged straight onto another list', async ($, on) => {
  const { server, ui } = await open($, on)
  server.l1 = '○ ID: t1\nTitle: Pay tax\nDue: 11/1/2026\n---'
  await ui.press({ key: 'refresh' })
  expect(await rows(ui)).toEqual(['Overdue / today', 'Pay tax', 'Lists', '▸ TR', '▸ Home'])
  // within Overdue there is nothing to reorder: letting go there does nothing
  await drag(ui, 1, 0)
  expect(server.calls.some(c => !c.tool.startsWith('get-task'))).toBe(false)
  await drag(ui, 1, 4)
  expect(server.calls.find(c => c.tool === 'create-task')?.args).toMatchObject({ listId: 'L2', title: 'Pay tax', dueDateTime: '2026-11-01T00:00:00' })
  expect(server.calls.find(c => c.tool === 'delete-task')?.args).toEqual({ listId: 'L1', taskId: 't1' })
  await ui.unmount()
})
