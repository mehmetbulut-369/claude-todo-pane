# todo-pane

Your Microsoft To Do tasks in a pane beside the Claude chat. You don't need another app or another window.

![todo-pane demo](assets/demo.gif)

## Why I built this

I work on a 13-inch laptop. Claude was one window and Microsoft To Do was another. Every time I opened Mission Control, I saw a pile of windows, and I kept jumping between the two. Each jump pulled me out of what I was doing for a moment, like a fox chasing too many rabbits at once. The extra app also took RAM it didn't need.

Most of my work already happens in Claude, so I brought the list there. Now my tasks sit in a pane next to the conversation. I can see what's overdue without leaving the chat, and one click ticks a task off. That's one window fewer. My laptop has more room, and so does my head.

It's a small thing, and it changed my day more than I expected. If you work the same way, here it is.

## What it does

- **Overdue / today** comes first, oldest first. Dates are red when late and amber when due today.
- **Important** lists starred tasks.
- **Lists** shows every list that has open tasks. Click one to expand it.
- **○** completes a task in Microsoft To Do itself, so the change syncs to your phone too. Use To Do to add or edit tasks.
- **↻** refreshes. The pane also refreshes on its own every 5 minutes.
- **`/todo`** reopens the pane if you closed it.

## Install

**1. Connect Microsoft To Do to Claude Code.** This plugin talks to To Do through [jordanburke/microsoft-todo-mcp-server](https://github.com/jordanburke/microsoft-todo-mcp-server). Set it up by following its README, then register it in Claude Code under the name `microsoft-todo`:

```bash
claude mcp add microsoft-todo -s user -- node /path/to/microsoft-todo-mcp-server/dist/cli.js
```

Run `/mcp` in Claude Code to check that `microsoft-todo` shows as connected.

**2. Install the plugin** at the prompt of a Claude Code session:

```
/plugin install todo-pane --marketplace mehmetbulut-369/claude-todo-pane
```

Answer `y` to add the marketplace, then choose a scope (`user` makes it available in all your sessions).

**3. Start a new session.** The pane opens by itself.

## How it works

![How todo-pane works](assets/how-it-works.gif)

No magic. Here is what happens behind the pane, in the same six steps as the animation:

1. **You open Claude Code.** Claude Code loads the plugin and runs its hooks module, [`hooks/register.tsx`](hooks/register.tsx), which is about 130 lines. On `session.start`, the module opens a pane, registers the `/todo` command and starts a 5-minute timer.
2. **The pane asks the MCP server on your Mac.** [MCP](https://modelcontextprotocol.io) (Model Context Protocol) is a standard way for Claude to talk to small helper programs. The plugin calls the `microsoft-todo` server through Claude Code's own connection (`$.mcp.call`). It first calls `get-task-lists`, then `get-tasks` for every list in parallel.
3. **The server asks Microsoft with your own login.** The MCP server holds your Microsoft sign-in and calls Microsoft Graph, Microsoft's official API. The plugin never sees a password or a token.
4. **Your lists come back as text.** The server answers in plain text (`Title: …`, `Due: …`). [`hooks/parse.ts`](hooks/parse.ts) turns that text into tasks, and the pane sorts them into *Overdue / today*, *Important* and *Lists*.
5. **Clicking ○ completes the task in To Do itself.** The plugin calls the server's `update-task` with `status: completed`. There is no local copy that could drift out of sync.
6. **So your phone sees it too.** Microsoft syncs the change everywhere you use To Do. The pane refreshes on its own every 5 minutes, or when you press ↻.

### What the plugin can and cannot do

- **Can:** read your To Do lists and open tasks, and mark a task as completed.
- **Doesn't:** create, edit or delete tasks or lists. It makes no network requests of its own and stores no credentials.
- **Stays local:** the plugin keeps the task list in the Claude Code session only to draw the pane. It does not send the list anywhere else.

## Design decisions

Each choice below has a cost. I wrote it down so the trade-off is visible, not hidden in the code.

- **Read and complete only.** The pane does one job: show what is open and tick it off. Adding and editing stay in To Do, which already does them well. A smaller surface means fewer ways to damage someone's task list.
- **Microsoft To Do is the only source of truth.** There is no local cache or database. Every view comes from a fresh call, and completing a task writes straight to To Do. The cost is a short wait on refresh; the gain is that the pane can never disagree with your phone.
- **Reuse the MCP server instead of calling Microsoft Graph.** Writing my own Graph client would mean handling OAuth, tokens and refresh myself. The existing server already does that, so the plugin holds no credentials at all. The cost is that I depend on its output format (see below).
- **Parse the server's text output.** The server returns formatted text, not JSON. [`hooks/parse.ts`](hooks/parse.ts) reads it with a few regular expressions, and tests pin the format. If the server changes it, tasks still show and only dates may drop. The code marks this as a shortcut to replace if the server ever offers JSON.
- **Poll every 5 minutes, plus a manual ↻.** Microsoft Graph supports change notifications, but they need a public webhook endpoint, which a local plugin does not have. For a to-do list, five minutes is fresh enough.
- **Fail soft.** Lists load in parallel. If one list returns an error, it shows as empty and the others still appear. If the whole refresh fails, the pane keeps the last good list and asks for one refresh instead of going blank. This usually happens when the pane opens before the MCP server has connected.
- **"Today" is your local day.** Due dates are calendar days, so overdue and today are compared against your local date, not UTC. Otherwise, in Germany, the first hour after midnight would still count as yesterday. A test pins this.

## Limitations

- Tested in the Claude desktop app (Code tab) on macOS. In the terminal, the pane docks beside the chat only in fullscreen at 110+ columns. Elsewhere it sits above the prompt.
- Due dates are read from the server's text output, which uses US date format (`11/20/2026`). If the server ever changes that format, dates won't show up, but tasks still will.
- At most 100 open tasks per list.

## Development

```bash
claude plugin validate .
claude plugin test .
```

To work on it locally, run `claude --plugin-dir .`. The plugin hot-reloads while you edit.

### The animations

Both animations are plain HTML with SVG and CSS ([`assets/demo.html`](assets/demo.html), [`assets/how-it-works.html`](assets/how-it-works.html)). Open either file in a browser and it plays.

To turn one into a video, [`assets/record.mjs`](assets/record.mjs) opens headless Chrome, pauses every animation, seeks to each frame's time and takes a screenshot. It needs no npm packages, only Node's built-in `fetch` and `WebSocket`. ffmpeg then joins the frames:

```bash
node assets/record.mjs /tmp/frames 30 16.5 how-it-works.html
ffmpeg -framerate 30 -i /tmp/frames/%04d.png -vf "scale=1280:-2,format=yuv420p" -c:v libx264 -crf 20 assets/how-it-works.mp4
```

## Credits

- **[microsoft-todo-mcp-server](https://github.com/jordanburke/microsoft-todo-mcp-server)** by Jordan Burke (MIT) does the real work of talking to Microsoft. This repository does not include or modify its code; you install it separately.
- **Drawing style:** the one-line look of the animations is a tribute to Osvaldo Cavandoli's *La Linea*. Only the technique is borrowed: a single white line, a flat color, and characters that grow out of the ground line. The fox, the rabbits and every drawing here are original.
- **Font:** [Inter](https://rsms.me/inter/) by Rasmus Andersson (SIL Open Font License).

## Trademarks

This is an independent, personal project. It is not affiliated with, sponsored by or endorsed by Microsoft or Anthropic. Microsoft and Microsoft To Do are trademarks of Microsoft Corporation. Claude and Claude Code are trademarks of Anthropic. Mission Control is a trademark of Apple Inc. All are used only to describe what this plugin works with.

## License

MIT, see [LICENSE](LICENSE). Third-party names and the MCP server keep their own licenses.
