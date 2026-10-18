# @ai-adoption-score/ai-coding-usage

The add-on behind [AI Coding Usage](https://ai-adoption-score.app/product/ai-coding-usage), a survey in AI Adoption
Score. It counts how a person uses Claude Code and Codex on their Mac and, once connected, shares the numbers with their
company's survey. Prompts, the AI's answers, code, file names, command text and session titles never leave the Mac.

You don't install it yourself: your survey page shows one line with a code,
`npx @ai-adoption-score/ai-coding-usage@1 connect <code>`, to paste into Claude Code, Codex or Terminal.

Connected once, it shares by itself: a hook in Claude Code and Codex syncs after a session's replies, at most every 5
minutes and always when a session ends, and an automatic ping-back, once an hour and without any numbers, tells the
report "no AI use today" from "no signal".

## Commands

- `connect <code> [--server <url>]`: links this Mac to the survey with the code from the survey page and puts the
  hooks and the ping-back in place. Then it sends the names of the repositories used in the last 30 days, and nothing
  else, so the person can choose on their survey page which to share; a background wait shares the last 30 days of
  those once they press Share. The server defaults to `https://app.ai-adoption-score.app`;
  `AI_ADOPTION_SCORE_SERVER` or `--server http://localhost:3000` point it at a local app. Run again on a Mac that is
  connected, it keeps that Mac's link on the same server (the survey page still shows one Mac) and lets the person
  choose again; a link on another server is disconnected, and its token never goes to the new one.
- `sync`: shares now instead of after the next session. It counts the window again and sends the rows that changed
  since the server last accepted them; the server replaces what it had, so nothing counts twice.
- `status`: which survey this Mac shares with, what the person chose, the hooks and when they last ran, and when it
  last shared.
- `disconnect`: stops sharing from this Mac and removes everything it put in place.
- `preview [--days 30] [--company github.com/acme] [--json]`: what would be shared, without sending.

The hooks run `hook <tool>` and the ping-back runs `check-in`, its name inside the add-on; people don't.

## What it puts in place

- `~/.ai-adoption-score/`, readable only by the Mac's user: `config.json` with the device token, `state.json` with a
  fingerprint of every row the server accepted and when each hook last ran, a short `log.txt`, a copy of the add-on in
  `app/` (a hook can't depend on npx's temporary folder), and `run.sh`, which finds Node for the hooks, because desktop
  apps don't load the shell's PATH.
- A hook for `SessionStart`, `Stop` and `SessionEnd` in `~/.claude/settings.json` and `~/.codex/hooks.json`, added
  after the hooks already there. The command never changes between versions, because Codex trusts a hook by its exact
  text, its name and its place. Codex runs it only once the person trusts it: the Codex app lists it under Settings →
  Hooks as "AI Adoption Score", a "New hook" with a Trust button, and Codex in Terminal asks when it starts.
- `~/Library/LaunchAgents/app.ai-adoption-score.check-in.plist`, the ping-back, once an hour at low priority.

The settings files are written in their own style (indent, last newline, `\u` escapes), through a link when the file
is one, so taking the hook out leaves them byte for byte as they were.

A hook prints nothing (a `SessionStart` hook's output would go into the conversation, and Codex refuses text from a
`Stop` hook), returns in about 40 ms and starts the sync in its own low-priority process. One sync runs at a time. A
sync that can't reach the server keeps the rows changed, so the next one sends them: the Mac is the queue.

**Each tool pauses on its own.** After the first sync, a tool's rows go out only while its hook is in place and has
run since connecting. Declining the Codex hook, or deleting either hook, pauses that tool; when the hook is back, the
waiting days go out, within the 30 days the records last.

**It removes itself** when the survey page disconnects the Mac or the survey closes: the next sync or ping-back hears
it and takes away the hooks, the ping-back and the folder. If someone deletes the folder by hand, the leftover hooks do
nothing, and `disconnect` still takes them away.

For testing, `AI_ADOPTION_SCORE_HOME`, `AI_ADOPTION_SCORE_CLAUDE_SETTINGS`, `AI_ADOPTION_SCORE_CODEX_HOOKS` and
`AI_ADOPTION_SCORE_LAUNCH_AGENTS` move each of these elsewhere, and `AI_ADOPTION_SCORE_SKIP_LAUNCHCTL=1` leaves launchd
alone. `AI_ADOPTION_SCORE_NODE` names a Node for `run.sh` to try.

## Try it

Count this Mac's last 30 days and see what would be shared, without connecting and without sending anything:

```bash
npx @ai-adoption-score/ai-coding-usage@1 preview
```

Add `--json` to see the exact rows, or `--days 7` for a shorter window. It needs Node.js 18.17 or newer and git, and
runs on macOS only for now.

## What it reads

- **Claude Code:** `~/.claude/projects/**/*.jsonl`, or `$CLAUDE_CONFIG_DIR/projects`. For each line: its kind, time,
  session, folder and branch, the model and token counts of the AI's replies, and the names of the tools it used.
  For the AI's edits, the diff Claude Code stores with each result. Lines that hold prompt text or titles
  (`last-prompt`, `custom-title`, `ai-title`) are skipped.
- **Codex:** `~/.codex/sessions/**/rollout-*.jsonl`, or `$CODEX_HOME/sessions`. For each line: its kind, time, thread,
  folder, repository and branch, the model, per-reply token records, and tool and connector names.
  `session_index.jsonl`, which holds thread names, is never opened.
- **The Claude desktop app's connector names:** only `remoteMcpServersConfig` in its session files, so claude.ai
  connectors show as "Notion" rather than an id. Everything else in those files is skipped.
- **git, in each session's folder:** the remote's address, which branches exist on a remote, and the person's own
  commits by time. No file is opened and nothing is fetched.

Text is looked at only to tell a prompt from a tool result and to count changed lines. An edited file's path is
used only to check that the edit is inside the session's project. Neither is ever kept.

## Which repositories

Nothing from the sessions leaves the Mac before the person chooses. The page lists the repositories the add-on found,
by owner, all ticked to start with; the names of the ones they untick are deleted when they press Share, and sessions
already shared from them are deleted too. Before every sync the add-on asks what they chose (`GET
/api/usage/repositories`) and sends only those sessions (`src/choice.mjs`); the server checks the same rule again.

A repository that shows up later is shared when its owner (`github.com/acme`) was ticked in full, and so is a new
folder without a remote when every such folder was ticked. Anything else stays on the Mac until the person runs the line
again and ticks it. Work outside any repository is one more box.

## What a row holds

One row per session, day, repository and branch: the tool, a hash of the session id, the day and the first and last
moment, the repository and branch and whether the branch is pushed, active minutes, prompts, stops, rejected actions,
commands, file edits, lines added and removed, connector calls by name, skills, helper agents, commits and pushed
commits, and per model its replies and tokens. `npx @ai-adoption-score/ai-coding-usage@1 preview --json` prints the exact rows this Mac
would send.

Never shared: prompts, AI answers, code, file names and paths, command text, session titles.

## How it counts

- Each Claude Code reply is written as several lines that repeat its usage, so it counts once, by message id and
  request id. A resumed session copies earlier lines into a new file, so each line counts once, by its id.
- A helper agent's file carries its parent's session id: its tokens and tool calls count in the parent session.
- A Codex thread that Codex starts itself, such as its automatic reviewer, counts in the session that started it,
  with no session or prompts of its own.
- Codex's input count includes the cached part; rows keep them apart, as Claude Code does.
- Connectors are tools someone connected: GitHub, Linear, Notion. The apps' own tools (the desktop app's browser,
  terminal and session tools, Codex's code runners) aren't counted.
- A removed folder, such as a deleted worktree, counts under the repository around it, when that still exists.
- An edit counts once Claude Code reports it done, and only inside the session's project: its repository, or its
  folder outside git. Its lines come from the diff Claude Code stores with the result, and a new file counts all its
  lines as added. A failed or turned-down edit, or a scratch file elsewhere, doesn't count.
- Active minutes add up the gaps under five minutes. A commit counts for the session whose window holds it, from its
  first moment to an hour after its last; each commit counts once.
