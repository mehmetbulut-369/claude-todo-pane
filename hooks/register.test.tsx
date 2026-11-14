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
