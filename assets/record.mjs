// Renders demo.html to PNG frames with headless Chrome (no npm packages: Node's built-in fetch + WebSocket).
// Usage: node assets/record.mjs <outDir> [fps=30] [seconds=10]
// Then: ffmpeg -framerate 30 -i <outDir>/%04d.png ... (see README "Rebuilding the demo")
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [out, fps = '30', secs = '10'] = process.argv.slice(2)
if (!out) throw new Error('usage: node record.mjs <outDir> [fps] [seconds]')
mkdirSync(out, { recursive: true })
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const port = 9333
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, '--hide-scrollbars', `--user-data-dir=${out}/.chrome`, 'about:blank'], { stdio: 'ignore' })

let target
for (let i = 0; i < 50 && !target; i++) {
  await new Promise(r => setTimeout(r, 200))
  target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json()).catch(() => null)
}
if (!target) throw new Error('Chrome did not start')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', m => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, msg => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)))
  ws.send(JSON.stringify({ id: n, method, params }))
})

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false })
await send('Page.enable')
await send('Page.navigate', { url: new URL('./demo.html', import.meta.url).href })
await new Promise(r => setTimeout(r, 1500))

const total = Math.round(Number(fps) * Number(secs))
for (let f = 0; f < total; f++) {
  await send('Runtime.evaluate', { expression: `seek(${f / Number(fps)})` })
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${out}/${String(f).padStart(4, '0')}.png`, Buffer.from(data, 'base64'))
}
ws.close()
proc.kill()
console.log(`${total} frames -> ${out} (${fileURLToPath(import.meta.url)})`)
