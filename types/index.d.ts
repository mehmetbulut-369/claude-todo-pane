export type Task = { id: string; title: string; due: string | null; isHigh: boolean }
export type TodoList = { id: string; name: string; tasks: Task[] }
export type Snapshot = { lists: TodoList[]; at: number; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'todo-pane': { snapshot: Shaped<Snapshot | null>; openList: string | null; busy: boolean; draft: string }
  }
}
