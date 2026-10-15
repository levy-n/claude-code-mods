# Claude Code mods for long sessions

Two [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview) for keeping long sessions healthy.

| Mod | What it does |
| --- | --- |
| [context-handoff](context-handoff/) | When the context grows heavy, offers to continue from the same point in a fresh window. The model writes a full handoff, the window clears, and the new conversation picks up from it. |
| [token-weather](token-weather/) | Anthropic's sample mod, unchanged: a forecast of the context window above the prompt. |

## Why

The model has no memory. On every turn Claude Code sends it the whole conversation again: the system prompt, CLAUDE.md, every message, every file it read, every command output. Each answer is appended, and the next turn sends all of it again, a little longer.

That pile is the context window. Opus 5.5 has a 1M-token window and auto-compacts at about 967K, but quality drops long before that: the model starts to forget early instructions, miss details and make more mistakes. token-weather shows how full it is. context-handoff gets you out of it without losing your place.

## Install

```
claude plugin marketplace add levy-n/claude-code-mods
claude plugin install context-handoff@levy-n-mods
claude plugin install token-weather@levy-n-mods
```

Inside a session, `/plugin marketplace add levy-n/claude-code-mods` and `/plugin install ...` do the same; run `/reload-plugins` to load them right away.

Requires Claude Code 2.1.287+ in the terminal, or 2.1.286+ in the desktop app's Code tab. Built and tested on Windows 10 with Claude Code 2.1.296.

## Before you install any mod

A mod runs inside Claude Code with your permissions and sees every message. Read what it does first:

```
claude plugin validate ./context-handoff
```

The `hooks:` and `calls:` lines list the events it handles and everything it asks Claude Code to do.

## License

context-handoff: MIT. token-weather: Apache License 2.0, copyright Anthropic PBC, from [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/token-weather).
