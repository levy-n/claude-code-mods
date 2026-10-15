# Claude Code mods for long sessions

Two [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview) for keeping long sessions healthy.

![context-handoff's offer above token-weather's forecast, over the prompt](context-handoff/screenshots/band-en.png)

| Mod | What it does |
| --- | --- |
| [context-handoff](context-handoff/) | When the context grows heavy, offers to continue from the same point in a fresh window. The model writes a full handoff, the window clears, and the new conversation picks up from it. |
| [token-weather](token-weather/) | Anthropic's sample mod: a forecast of the context window above the prompt. Patched to share that band with other mods; the original draws its line and hides any mod that comes after it. |

## Why

The model has no memory. On every turn Claude Code sends it the whole conversation again: the system prompt, CLAUDE.md, every message, every file it read, every command output. Each answer is appended, and the next turn sends all of it again, a little longer.

That pile is the context window. Opus 5.5 has a 1M-token window and auto-compacts at about 967K, but quality drops long before that: the model starts to forget early instructions, miss details and make more mistakes. token-weather shows how full it is. context-handoff gets you out of it without losing your place.

## Why not just /compact?

Compacting writes a summary too. The difference is when it is written, what goes into it, and where it stays.

- **When.** Auto-compact fires when the window is nearly full, in the middle of whatever is running, at the point where the model is most crowded. The handoff is offered at 500K, and you pick the moment.
- **What.** The handoff follows a fixed outline: your instructions quoted word for word, what was verified and what was only assumed, what was tried and failed and why, and the next step down to the command. What can be measured (edited files, folders, your last request) the mod collects itself instead of trusting the model's memory. The new conversation opens with a few lines on where things stand, so you see right away whether it understood.
- **Where.** A compact summary stays inside the same conversation, and the next compaction summarizes that summary. The handoff is a file in your project: you can read it, fix it before carrying on, or come back to it next week, and the old conversation stays whole under Resume.

If auto-compact runs anyway, context-handoff adds the same checklist to its instructions.

## Install

```
claude plugin marketplace add levy-n/claude-code-mods
claude plugin install context-handoff@levy-n-mods
claude plugin install token-weather@levy-n-mods
```

Inside a session, `/plugin marketplace add levy-n/claude-code-mods` and `/plugin install ...` do the same; run `/reload-plugins` to load them right away.

Requires Claude Code 2.1.287+ in the terminal, or 2.1.286+ in the desktop app's Code tab. Built and tested on Windows 10 with Claude Code 2.1.296.

If you already use Anthropic's own token-weather, replace it with this one, or context-handoff's band may not show.

## Before you install any mod

A mod runs inside Claude Code with your permissions and sees every message. Read what it does first:

```
claude plugin validate ./context-handoff
```

The `hooks:` and `calls:` lines list the events it handles and everything it asks Claude Code to do.

## License

context-handoff: MIT. token-weather: Apache License 2.0, copyright Anthropic PBC, with one marked change, from [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/token-weather).
