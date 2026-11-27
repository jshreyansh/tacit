# Agents in browsers

How agents act in Tacit's browsers, and the plan to bring it on par with the
best current tools (Playwright MCP, Chrome DevTools MCP, Claude in Chrome,
browser-use, Stagehand). The full plan, written by Claude and Codex
separately and merged, is the "Agents in browsers" page shared on 2026-11-26.

## What is true now (after Stages 1–3 and the core of 4)

- **Who is asking.** Each terminal Tacit starts gets its own credential
  (`TACIT_TERMINAL_TOKEN`, `electron/terminal-credentials.ts`), worked out from
  a secret made at launch; nothing is stored. The tool server sends it with
  every call (`X-Tacit-Terminal`, `X-Tacit-Terminal-Token`). The browser
  action route believes only a terminal that proved who it is, and only as
  itself: no credential is a 401 (`unverified_terminal`), naming another
  terminal is a 403 (`caller_mismatch`). There is no "system" caller for
  browser actions any more; before, a call naming no terminal skipped the wire
  check.
- **Where the credential goes.** Into the terminal's environment and its tool
  server's launch settings: a per-terminal temporary file for Claude Code and
  Gemini, `OPENCODE_CONFIG_CONTENT` for OpenCode, and for Codex its own
  environment, forwarded to the tool server through `env_vars`.
  Never into the settings file every Antigravity terminal shares
  (`~/.gemini/antigravity-cli/mcp_config.json`); agy passes its own
  environment to the tool server. A terminal never inherits another's
  credential (`TACIT_RUNTIME_ENV_BLOCKLIST`).
- **Only main makes credentials.** An agent started by typing its name in a
  Tacit shell passes on the shell's own (`cli/agent-shims/run.ts`). Codex gets
  it through `env_vars` from its own environment, never as an argument, since
  arguments are visible to other processes and copied into telemetry. Telemetry
  masks secrets in process command lines, and the secret masker knows the
  credential's name. The `tacit` command sends the credential too.
- **Moving a tile is open; sending it somewhere isn't.** `PUT /browser/:id`
  takes only `x`, `y`, `w`, `h` and `url`. A `url` is a navigation, checked like
  any browser action, and now really loads in an open tile. A tile's profile
  is never changed through the API: it's the person's choice.
- **The wire is the permission**, checked in main on every action: a terminal
  reaches only the browser it's wired to, along the wire's direction; a
  read-only wire allows `read` only.
- **Actions run in main** (`electron/browser-service.ts`). Main asks the
  window one question per action (`__tcApi.browserActionContext`): does the
  tile exist, what backend, which guest page, may agents act on its profile
  now. Main then checks the page is a `webview` guest of Tacit's own window
  and does the action on its webContents, or sends a connected tab's action to
  the broker. Nothing an agent asks for runs in the window.
- **The person's own Send on a wire** goes the same way (`browser:drive`,
  sender-checked), recorded as `user`.
- **Every action is recorded** (`browser_action`, with the actor).

### Seeing the page (Stage 2)

- **One outline of the page** (`browser_snapshot`): roles, names, values and
  states, with a handle for each thing an agent can use (`e12`; `f1e3` inside
  frame `f1`). It reaches into open shadow roots and into frames from other
  sites, each frame under its `<iframe>` line. A frame from another site isn't
  in its parent's frame tree; its parent comes with its target
  (`parentFrameId`). Handles are kept in the page (a `WeakMap`), not on the
  elements, and go on numbering across documents and frames: a handle from a
  page that's gone never names something on the new one. Password fields are
  marked and their values never read.
- `browser_find` finds lines by words; `browser_read` reads the page's text a
  page at a time; `browser_screenshot` returns a picture (JPEG, scaled) whose
  points can be clicked.
- Screenshots are taken as drawn, with no clip: Chromium takes a clip as a
  stand-in viewport and waits for the page to draw at it, and Excel never did,
  so that capture and every later one timed out. The PNG comes at the screen's
  density and see-through where the page has no background; main puts it on
  white (as the tile shows it) and scales it to the page's size as a JPEG.
- Everything from the page is marked as the page's words, not instructions
  (`tacit-bridge/src/mcp-server.ts`).
- The page script (`shared/browser-page-script.ts`) runs in its own isolated
  world in each frame, so a page can't see or change it.

### Acting like a person (Stage 3)

- **Real input, from main** (`electron/browser-driver.ts`), through CDP on the
  tile's `webContents.debugger`: mouse events, key presses with their text one
  character at a time (what Excel's grid takes), key chords naming macOS's
  editing command (`Meta+A` is `selectAll`), and paste through the clipboard,
  which is put back afterwards (text, rich text, a picture). One paste at a
  time across all tiles, since the clipboard is the whole computer's. A key
  chord that would paste the person's own clipboard (`Cmd+V`, `Ctrl+V`,
  `Shift+Insert`) is refused; agents paste only their own text.
- **Focus into frames from other sites**: after a click on something in one,
  keys wait until that frame has the keyboard (Chromium hands it over a moment
  later).
- **Keys only reach a page that has the keyboard**: a key the page doesn't
  take goes back to Tacit's window, to whatever has the keyboard there. An
  Escape sent while the person was typing in an agent's terminal stopped that
  agent. Before each key press (and before inserted text) the driver asks the
  window whether its focused element is this tile; if not, nothing is sent and
  the agent is told to click in the page first. The page's own focus can't
  tell (it says "no" whenever the window is covered), nor can its webContents'
  (it says "yes" whenever the window is in front).
- **`browser_act`**: up to 20 steps (click, fill, type, press, select, check,
  hover, drag, scroll, upload, paste, wait), checked before any runs; the first
  that fails stops the rest and says why. It answers with what changed in the
  outline.
- **Before a click**: the element is scrolled into view and waited on until it
  stops moving; each `<iframe>` around it is scrolled into view in its own page;
  and the point is checked to reach it, in its own frame and through every
  frame around it. Something covering it (a cookie banner) is named, not
  clicked through.
- **Refused plainly**: text into a password field, however it got the
  keyboard (a click and then typing, a character key, a paste): checked on the
  focused element in whichever frame has focus, through shadow roots;
  `fill` on something that isn't a text field (it says to click and type, for
  a grid or canvas); uploading a file that isn't in the workdesk's folders.
- **Dialogs**: an alert or confirm doesn't hang the step that opened it; it's
  reported, everything but `browser_dialog` is refused while it's open, and
  `browser_dialog` accepts or dismisses it.
- `browser_eval` stays, and is the one browser tool Claude Code still asks
  about.

### Several agents, several browsers (Stage 4 core)

- **Which browser**: every browser tool takes `browser` (an id, or words from
  its title or address); the default is the newest wire. `browser_list` shows
  the terminal's browsers. A pop-up opens as its own tile, wired like the tile
  that opened it. Spawning a browser adds a wire; it doesn't drop the others.
- **One agent changes a page at a time**: a lease, held until 30 s after its
  last change. Another agent's change is refused with who holds it; reading is
  never refused. An action waiting behind another is checked again when its
  turn comes (Stop, the profile's permission, the lease).
- **The person wins**: their own click or key press in the tile keeps agents
  off until 15 s after the last one, whether or not an agent was on the page
  (the bar says so only when one is). A press the page reports is the agent's
  only if the driver sent one it hasn't reported yet; everything else is the
  person's. Stop on the tile's bar keeps agents off until Resume (or 120 s)
  and stops one mid-way: Stop, the person's hands and another agent's lease are
  checked before every input event. The person's own Send still works. The bar
  shows which agent is driving.
- **Kept drawing while driven**: a tile off screen or behind grid view is
  placed where it still draws, nearly transparent and behind everything, for
  10 s after the last action ends (`data-awake`,
  `src/browser/browserDriving.ts`); background throttling is off for the
  window and the tile meanwhile.
- **Covered by other windows**: Tacit starts with Chromium's
  `disable-backgrounding-occluded-windows`, so its window keeps drawing while
  other apps cover it. Without it, frames from other sites inside a tile
  (Excel Online's grid) stop drawing and drop input, and nothing per page can
  keep them going. Minimized still stops drawing.

## What Stage 0 showed

- Real input from main works: `webContents.debugger` (already attached for the
  Chrome identity) with `Target.setAutoAttach({flatten:true})` reaches frames
  from other sites; `Input.dispatchMouseEvent`, key events, and
  `Input.insertText` type into a canvas grid that ignores script-made events,
  and it saves.
- Excel Online needs each character as a key press (`keyDown` with `text`),
  not `insertText`. After the Name Box, click the cell before typing. Enter
  after a row of Tabs doesn't return to the row's first column.
- A tile off screen, or hidden behind grid view, drops input (about 4 s, no
  error) and can't be screenshotted, even with throttling off. Its element
  placed inside the window (nearly transparent, behind everything, not
  `pointer-events: none`) works. The driver must check visibility itself.
- Use a page's own auto-attached targets, never `Target.getTargets`, which
  lists every page in the app.

## Stages

0. Spike: prove real input from main, Excel Online. Done.
1. Driver in main, caller identity, checks in main. Done.
2. See: page outline with handles across frames and shadow roots, find,
   paged reading, screenshots. Done.
3. Act like a person: `browser_act` with real clicks, typing, keys, paste,
   uploads, dialogs, waits. Done.
4. Many agents, many browsers, safety. Done: naming the browser, pop-ups as
   tiles, leases, the person wins, kept awake, passwords refused, page content
   marked as data, scripts asked about. Not yet: connected Chrome tabs at par
   with tiles (they still have read, navigate and click only), approval
   before sensitive steps (purchases, sending), redacting secrets in what the
   page shows.
5. Prove it against Playwright MCP and Chrome DevTools MCP on a fixed task set.
