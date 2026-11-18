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
    const desc = /Description: (.+)/.exec(block)?.[1] ?? null
    const cats = /Categories: (.+)/.exec(block)?.[1].split(', ') ?? []
    return [{ id, title, due, isHigh: /Importance: high/.test(block), desc, cats }]
  })
}

// Due dates are calendar days, so "today" must be the user's local day, not the UTC day.
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// The server cuts a description at 50 characters and adds "..."; such a note can't be copied whole.
export const isCut = (desc: string | null) => desc !== null && desc.length === 53 && desc.endsWith('...')

export function parseChecklist(text: string): { name: string; isChecked: boolean }[] | null {
  if (text.startsWith('No checklist items')) return []
  if (!text.startsWith('Checklist items')) return null
  return [...text.matchAll(/^(✓|○) (.+) \(ID: \S+\)$/gm)].map(m => ({ name: m[2] ?? '', isChecked: m[1] === '✓' }))
}

// Sorts items by a saved id order; items the order has never seen (new in To Do) come first, as To Do shows them.
export function byOrder<T extends { id: string }>(items: T[], ids: string[] | undefined): T[] {
  const at = new Map((ids ?? []).map((id, i) => [id, i]))
  const fresh = items.filter(x => !at.has(x.id))
  return [...fresh, ...items.filter(x => at.has(x.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!)]
}

// Moves id to just before `before` (null: to the end).
export function place(ids: string[], id: string, before: string | null): string[] {
  const rest = ids.filter(x => x !== id)
  const i = before === null ? -1 : rest.indexOf(before)
  return i < 0 ? [...rest, id] : [...rest.slice(0, i), id, ...rest.slice(i)]
}
