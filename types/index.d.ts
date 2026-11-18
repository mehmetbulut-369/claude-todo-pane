export type Task = { id: string; title: string; due: string | null; isHigh: boolean; desc: string | null; cats: string[] }
export type TodoList = { id: string; name: string; tasks: Task[] }
export type Snapshot = { lists: TodoList[]; at: number; error: string | null }
// The pane's own order: Microsoft Graph has no way to store task or list order.
export type Order = { lists: string[]; tasks: Record<string, string[]> }

// What the board (a Client surface module) draws: one row per line, so a pointer row is a row index.
export type Row =
  | { kind: 'list'; id: string; name: string; n: number; open: boolean }
  | { kind: 'task'; id: string; listId: string; title: string; meta: string; tone: 'error' | 'suggestion' | 'inactive'; isHigh: boolean }
export type BoardProps = { rows: Row[] }
// What the board posts back to the hooks module.
export type BoardMsg =
  | { op: 'toggle'; listId: string }
  | { op: 'complete'; listId: string; id: string }
  | { op: 'reorderList'; id: string; before: string | null }
  | { op: 'reorderTask'; listId: string; id: string; before: string | null }
  | { op: 'move'; listId: string; id: string; toList: string; before: string | null }
  | { op: 'into'; listId: string; id: string; toList: string; to: string }

declare module 'claude-code' {
  interface PluginState {
    'todo-pane': { snapshot: Shaped<Snapshot | null>; openList: string | null; busy: boolean; order: Order }
  }
}
