// 헤드리스 Chrome CDP 공용 도우미
const { spawn } = require("child_process");
const wait = ms => new Promise(r => setTimeout(r, ms));
async function open(sp, port = 9333) {
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const p = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${sp}/chprof${port}`, "--no-first-run", "--hide-scrollbars", "--lang=ko-KR", "--autoplay-policy=no-user-gesture-required", "about:blank"]);
  for (let i = 0; i < 40; i++) { await wait(250); try { var tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.find(t => t.type === "page")) break; } catch {} }
  const ws = new WebSocket(tabs.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {}, handlers = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } else if (m.method) handlers.forEach(h => h(m)); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async x => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
  return { send, ev, on: h => handlers.push(h), close: () => { ws.close(); p.kill(); } };
}
module.exports = { open, wait };
