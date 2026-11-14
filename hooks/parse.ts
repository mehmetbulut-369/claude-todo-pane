import type { Task } from '../types'

// shortcut: the server only returns formatted text (en-US M/D/YYYY dates); switch to JSON if the server ever offers it.
export function parseLists(text: string): { id: string; name: string }[] {
  return [...text.matchAll(/ID: (\S+)\nName: (.+)/g)]
    .map(m => ({ id: m[1], name: m[2].replace(/ \((Default Tasks List|Shared by you|Flagged Emails)\)$/, '') }))
}

export function parseTasks(text: string): Task[] {
  return text.split('\n---').flatMap(block => {
    const id = /ID: (\S+)/.exec(block)?.[1]
    const title = /Title: (.+)/.exec(block)?.[1]
    if (!id || !title || block.includes('✓ ID:')) return []
    const d = /Due: (\d+)\/(\d+)\/(\d+)/.exec(block)
    const due = d ? `${d[3]}-${d[1].padStart(2, '0')}-${d[2].padStart(2, '0')}` : null
    return [{ id, title, due, isHigh: /Importance: high/.test(block) }]
  })
}

// Due dates are calendar days, so "today" must be the user's local day, not the UTC day.
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
