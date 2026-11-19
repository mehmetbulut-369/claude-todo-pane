import { expect, test } from 'claude-code/testing'
import { localDay, parseLists, parseTasks } from './parse'

const PANE = {
  plugin: 'todo-pane', component: 'Pane', requestId: 'todo',
  props: { title: 'To Do', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const text = (t: string) => ({ value: { content: [{ type: 'text', text: t }], isError: false } })

test('parser', async () => {
  expect(parseLists('ID: a1\nName: Tasks (Default Tasks List)\n---\nID: b2\nName: TR\n---')).toEqual([
    { id: 'a1', name: 'Tasks' }, { id: 'b2', name: 'TR' },
  ])
  expect(parseTasks('○ ID: x\nTitle: A task\nDue: 11/5/2026\nImportance: high\n---\n✓ ID: y\nTitle: Bitti\n---\n○ ID: z\nTitle: Other\n---')).toEqual([
    { id: 'x', title: 'A task', due: '2026-11-05', isHigh: true },
    { id: 'z', title: 'Other', due: null, isHigh: false },
  ])
})

test('today is the local date, not the UTC date', async () => {
  // 00:30 local time: in Germany (UTC+1) the UTC date is still the day before
  expect(localDay(new Date(2026, 10, 14, 0, 30).getTime())).toBe('2026-11-14')
  expect(localDay(new Date(2026, 10, 14, 23, 59).getTime())).toBe('2026-11-14')
})

test('pane shows overdue and completes a task', async ($, on) => {
  const calls: string[] = []
  on('command.register', () => ({ value: { command: 'todo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-13T10:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('mcp.call', (_, e: any) => {
    calls.push(e.tool)
    if (e.tool === 'get-task-lists') return text('ID: L1\nName: TR\n---')
    // like the real server: a completed task no longer comes back
    if (e.tool === 'get-tasks') return text(calls.includes('update-task') ? 'No tasks found' : '○ ID: t1\nTitle: Pay tax\nDue: 11/1/2026\nImportance: normal\n---')
    return text('ok')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Pay tax/ }))?.text).toContain('Pay tax')
  await ui.press({ key: 'done-t1' })
  expect(calls).toContain('update-task')
  expect(await ui.find({ type: 'Text', text: /Pay tax/ })).toBeFalsy()
  await ui.unmount()
})

// A fake To Do server whose behaviour each test can switch while the pane is open.
function fakeServer(on: any) {
  const state = { mode: 'ok' as 'ok' | 'throw' | 'listsError' | 'oneListError' }
  on('command.register', () => ({ value: { command: 'todo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-13T10:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('mcp.call', (_: any, e: any) => {
    if (state.mode === 'throw') throw new Error('MCP server microsoft-todo is not connected')
    if (e.tool === 'get-task-lists') {
      if (state.mode === 'listsError') return { value: { content: [{ type: 'text', text: 'Authentication expired' }], isError: true } }
      return text('ID: L1\nName: TR\n---\nID: L2\nName: Home\n---')
    }
    if (e.tool === 'get-tasks') {
      if (state.mode === 'oneListError' && e.args?.listId === 'L1') return { value: { content: [{ type: 'text', text: 'boom' }], isError: true } }
      return text(e.args?.listId === 'L1' ? '○ ID: t1\nTitle: Pay tax\n---' : '○ ID: t2\nTitle: Buy milk\n---')
    }
    return text('ok')
  })
  return state
}

const shows = async (ui: any, re: RegExp) => Boolean(await ui.find({ type: 'Text', text: re }))

test('a failed refresh keeps the last good list and asks for a refresh', async ($, on) => {
  const server = fakeServer(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'list-L2' })).toBeTruthy()

  server.mode = 'throw'
  await ui.press({ key: 'refresh' })
  expect(await shows(ui, /Tap ↻ once/)).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'list-L2' })).toBeTruthy()

  server.mode = 'ok'
  await ui.press({ key: 'refresh' })
  expect(await shows(ui, /Tap ↻ once/)).toBe(false)
  await ui.unmount()
})

test('an error on the list call is a failed refresh, not an empty account', async ($, on) => {
  const server = fakeServer(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'list-L2' })).toBeTruthy()

  server.mode = 'listsError'
  await ui.press({ key: 'refresh' })
  expect(await shows(ui, /Tap ↻ once/)).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'list-L2' })).toBeTruthy()
  await ui.unmount()
})

test('one failing list does not hide the others', async ($, on) => {
  const server = fakeServer(on)
  server.mode = 'oneListError'
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'list-L2' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'list-L1' })).toBeFalsy()
  await ui.unmount()
})

const addSetup = (on: any, created: any[], reply: string) => {
  on('command.register', () => ({ value: { command: 'todo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-13T10:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('mcp.call', (_: any, e: any) => {
    if (e.tool === 'get-task-lists') return text('ID: L1\nName: Work\n---\nID: D1\nName: Tasks (Default Tasks List)\n---')
    if (e.tool === 'create-task') { created.push(e.args ?? e.input ?? e.arguments); return text(reply) }
    if (e.tool === 'get-tasks') return text(created.length ? '○ ID: n1\nTitle: Buy milk\nImportance: normal\n---' : 'No tasks found')
    return text('ok')
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
}

test('typing a title and Enter adds it to the default list', async ($, on) => {
  const created: any[] = []
  addSetup(on, created, 'Task created successfully!\nID: n1\nTitle: Buy milk')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'new-task', text: '  Buy milk ' })
  expect(created).toHaveLength(1)
  expect(JSON.stringify(created[0])).toContain('"listId":"D1"')
  expect(JSON.stringify(created[0])).toContain('"title":"Buy milk"')
  expect((await ui.find({ type: 'Text', text: /open ·/ }))?.text).toMatch(/^[1-9]/)
  await ui.unmount()
})

test('a blank title adds nothing, and a failed add tells you', async ($, on) => {
  const created: any[] = []
  addSetup(on, created, 'Failed to create task in list: D1')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'new-task', text: '   ' })
  expect(created).toHaveLength(0)
  await ui.input({ key: 'new-task', text: 'Buy milk' })
  expect(created).toHaveLength(1)
  await ui.unmount()
})
