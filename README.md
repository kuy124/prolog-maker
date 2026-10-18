# Prolog Room

Write and run SWI-Prolog with other people in the same room. Peer to peer, no
account, no server, no cost.

The engine is [SWI-Prolog](https://www.swi-prolog.org/) compiled to WebAssembly,
so it runs in your browser — there is nothing to install and nothing to pay for.
Collaboration is peer to peer over WebRTC, and the whole thing is a static site
on GitHub Pages.

## Run and verify

```bash
npm install
npm run dev
npm run verify
```

`npm run verify` runs unit tests, a typecheck, a production build, and browser
tests. The browser tests start Vite preview and a local y-webrtc signaling
server; they do not depend on a public service.

## Write and run

Type in the program editor. Everyone in the room edits the same program, and
edits merge as you type — two people changing different clauses do not collide.

Type a goal in the console and press **Enter**. Solutions arrive one at a time:

- **Next solution** asks the engine for another, so a query with a million
  solutions shows its first few without computing the rest.
- **Stop** abandons the rest. Because a Prolog goal cannot be interrupted once it
  starts, Stop replaces the engine and reloads the program. Solutions already on
  screen stay.

Press **?** for help.

## Facts

A fact is a clause with no body, and it is shared: everyone in the room sees it,
and it is asserted into every peer's own engine. Facts are deliberately data
rather than `assert/1` calls, because the engine is local — a fact one person
adds has to arrive as data and be re-asserted everywhere, and the program can be
rewritten without losing them.

Four examples open in a new room: a family tree, list basics, eight queens, and a
small definite-clause grammar.

## Sharing

A room code is the whole address. **Share** offers two links:

- a short link that needs somebody already in the room to hand it over, and
- a longer link that carries the program, and opens a copy with nobody online.

The second is what you want for a handout, a homework exercise, or anything that
has to outlive a browser tab.

**Save a copy** writes a JSON file with the program, the facts, and the log. It
needs nobody online and cannot be truncated by a chat app.

## Trust

Everyone in a room can edit the program, and the program runs in **your** browser.
The WebAssembly build of SWI-Prolog is unrestricted by design: a clause can call
`js_run_script/1` and run JavaScript in the page.

That is the same trust you extend by opening somebody's `.pl` file. Treat a room
code like a password to a shared document, and only join rooms from people you
would run code from.

## Documents and rooms

There is no server, so a room lives in this browser and in the browsers of whoever
is in it. A reload keeps your work — the room is remembered locally and its
document is cached in IndexedDB. Clearing browser data loses it, so **Save a
copy** first if the work matters.

## Connectivity

A signaling server does one job: introduce two peers so they can open a direct
connection, then get out of the way. It never sees document content, because the
room id doubles as the encryption key.

The default is `wss://signaling.fly.dev`. It works, but public servers come and
go — of the candidates checked in October 2026 it was the only one that introduced
peers, so treat it as replaceable:

```bash
node scripts/probe-collab.mjs
```

That probe opens two isolated browsers against each candidate and reports which
ones actually converge on one document. It has to run in a browser: Node has no
`RTCPeerConnection`, so a Node-side probe would report every server as broken.

Override the server in any of three ways, in priority order:

1. `window.__PROLOG_SIGNALING__` — a runtime array
2. `?signaling=wss://host1,wss://host2` — for a self-hosted server
3. `VITE_SIGNALING` at build time — comma-separated

To run your own, `npx y-webrtc-signaling` is enough. On a free tier a Cloudflare
Worker also works.

If no server is reachable the app still works: tabs in the same browser sync over
BroadcastChannel, and share links carry the program. Only cross-device live
editing is lost, and the status line says so.

## Keyboard

| Key | Action |
| --- | --- |
| Enter | Run the goal, from the console |
| Ctrl or ⌘ + Enter | Run the goal, from anywhere |
| Ctrl or ⌘ + S | Download the program |
| ? | Open help |
| Escape | Close a dialog |

## Themes

The workspace follows your system setting and respects reduced motion. Help offers
**Paper**, **Ink**, **Solarized Light** and **Solarized Dark** — palettes other
tools already ship, so a theme is recognizable before it is read. A theme is a
sheet of paper and the ink on it: only the colour tokens change.

`tests/unit/theme.test.ts` holds every palette to the same floor: 4.5:1 for text,
3:1 for syntax colours, and text on a filled button. Read it before changing a
token.

## How it is built

```
src/
  engine/     the Prolog engine: engine.ts is the logic, engine.worker.ts a shim
  editor/     the program editor and its Prolog syntax highlighter
  collab/     Yjs document, WebRTC provider, peer identity
  ui/         console, facts, presence, dialogs, themes
  model/      term rendering, share links, examples
```

Two decisions shape the rest, both forced by how the WebAssembly build behaves.
Both are documented at length in `src/engine/engine.ts`:

1. **Only one query may be open at a time, and it must be closed.** Opening a
   second query while the first has alternatives leaves the engine reporting
   `Unknown procedure` for everything afterwards, permanently.

2. **A syntax error half-loads the file.** Both `consult/1` and `load_files/2`
   load the clauses before the bad one and then report it, so a broken edit would
   silently replace a working program with a truncated one. The program is
   validated before it is loaded, and a bad edit leaves the previous program
   running.

The engine runs in a Web Worker. A Prolog goal cannot be interrupted — this build
has no `call_with_time_limit/2` and no `alarm/4`, because both need threads — so
Stop terminates the worker and starts a replacement, which is only possible
because the engine is not on the main thread.

## Reference

The engine is [swipl-wasm](https://github.com/SWI-Prolog/npm-swipl-wasm) 8.2.3,
vendored into `public/engine/` by `npm run vendor` and pinned by
`package-lock.json`. Collaboration uses [Yjs](https://github.com/yjs/yjs) with
[y-webrtc](https://github.com/yjs/y-webrtc).

SWISH is the reference for how a Prolog console should read. This app is not a
hosted Prolog service: there is no shared engine, so two people in a room run the
same program in their own browsers.