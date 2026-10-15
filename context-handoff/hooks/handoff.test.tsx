import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  WORDS,
  buildFile,
  editedFiles,
  factsBlock,
  isUsable,
  joinPath,
  lastUserText,
  nextOffer,
  normPath,
  offerLine,
  parseAt,
  parseCommand,
  parseHandoff,
  goalLine,
  readOwnFile,
  resumePrompt,
  tokensText,
} from './core'
import type { Facts, Pending } from './core'

const ok = (value: unknown) => ({ value }) as never
const VOID = { value: undefined } as never
const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
const NOW = Date.parse('2026-10-15T12:00:00Z')

const GOOD = `STATUS: CONTINUE
=== GOAL ===
Build the context-handoff mod. Latest request: "תבנה את זה" (partly answered).
=== NEXT_STEPS ===
1. Run claude plugin test.
=== IN_PROGRESS ===
- [ ] Live desktop test UNVERIFIED (build status: continues on CI)
=== CONSTRAINTS ===
- "תעבוד אוטונומית עד שהכל מוכן"
=== KEY_DECISIONS ===
- Fork first, because it sees the whole session.
=== KNOWN_ISSUES ===
none
=== COMPLETED ===
- [x] core.ts written (tsc clean)
=== IMPORTANT_FILES ===
- hooks/register.tsx
=== ENVIRONMENT ===
- claude plugin test .
=== WORKSPACE_NOTES ===
none
=== END ===`

const SECOND = GOOD.replace('Build the context-handoff mod.', 'Ship version two.')
const CUT = GOOD.replace(/=== ENVIRONMENT ===[\s\S]*$/, '=== ENVIRONMENT ===\n- claude plugin te')

const MESSAGES = [
  { role: 'user', text: 'תבנה את ה-mod', toolUses: [] },
  { role: 'assistant', text: 'ok', toolUses: [{ tool_use_id: 't1', tool: 'Write', input: { file_path: 'C:\\work\\proj\\hooks\\core.ts' } }, { tool_use_id: 't2', tool: 'Read', input: { file_path: 'C:\\x.md' } }] },
  { role: 'user', text: '<system-reminder>ignore</system-reminder>', toolUses: [] },
  { role: 'assistant', text: 'ok', toolUses: [{ tool_use_id: 't3', tool: 'Edit', input: { file_path: 'C:\\work\\proj\\hooks\\register.tsx' } }] },
]

type Reply = string | 'error' | 'nothing'

type Opts = {
  surface?: 'terminal' | 'desktop' | 'none'
  replies?: Reply[]
  files?: Record<string, string>
  turns?: number
  seed?: Record<string, unknown>
  attended?: boolean
  root?: string
  repo?: string | null
  gitFile?: boolean
  /** replaces the default model.fork answer */
  fork?: (prompt: string) => Promise<unknown>
  /** replaces the default command.run answer; the default clears (raises session.end) */
  commandRun?: (command: string) => Promise<unknown>
  /** a submitted prompt resolves only once session.start has returned, as a real engine starts no turn before that */
  isSubmitHeldUntilStart?: boolean
  /** nothing in the store yet: no language learned */
  isNewInstall?: boolean
}

function world(on: On, opts: Opts = {}) {
  const clock = mock.clock(on, { now: NOW })
  // The desktop tests stand for a person who writes Hebrew; a test that wants a fresh install says so.
  const seed = opts.surface === 'desktop' && opts.isNewInstall !== true ? { lastLang: 'he', ...(opts.seed ?? {}) } : (opts.seed ?? {})
  const store = new Map<string, unknown>(Object.entries(seed))
  on('store.get', async ($, e) => ok(store.get(e.key)))
  on('store.set', async ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return VOID
  })
  on('store.delete', async ($, e) => {
    store.delete(e.key)
    return VOID
  })
  on('store.keys', async () => ok([...store.keys()]))
  mock.env(on, opts.attended === false ? {} : { CLAUDE_CODE_SESSION_ATTENDED: '1' })
  const files: Record<string, string> = {}
  const mtimes: Record<string, number> = {}
  for (const [k, v] of Object.entries(opts.files ?? {})) {
    files[norm(k)] = v
    mtimes[norm(k)] = NOW - 86_400_000
  }
  const surfaces = opts.surface === 'none' ? [] : [opts.surface ?? 'terminal']
  const live = { tokens: undefined as number | undefined, turns: opts.turns ?? 0, surfaces, root: opts.root ?? 'C:\\work\\proj' }
  const forks: string[] = []
  const replies = [...(opts.replies ?? [GOOD])]
  const submitted: { text: string; asUser?: boolean }[] = []
  const commands: string[] = []
  const compactions: (string | undefined)[] = []
  let engine: Engine | undefined
  const bind = ($: Engine) => {
    engine = $
  }
  let markStarted = () => {}
  const started = new Promise<void>(r => {
    markStarted = r
  })

  on('model.fork', async ($, e) => {
    forks.push(e.prompt)
    if (opts.fork) return opts.fork(e.prompt) as never
    const r = replies.shift() ?? GOOD
    if (r === 'error') return ok({ isAnswered: false, reason: 'api-error', status: 500, error: 'boom', usage: {} })
    if (r === 'nothing') return ok({ isAnswered: false, reason: 'nothing-to-fork' })
    return ok({ isAnswered: true, text: r, usage: {} })
  })
  on('session.usage', async ($, e) => {
    const breakdown = (e as { breakdown?: string } | undefined)?.breakdown
      ? { autoCompactThreshold: 967_000, isAutoCompactEnabled: true, rawMaxTokens: 1_000_000 }
      : undefined
    return ok({ startedAt: 0, context: { tokens: live.tokens, window: 1_000_000, percent: live.tokens === undefined ? undefined : Math.round(live.tokens / 10_000), breakdown }, rateLimits: [] })
  })
  on('session.surfaces', async () => ok(live.surfaces))
  on('session.turns', async () => ok(live.turns))
  on('session.id', async () => ok('sess-1234abcd-old'))
  on('session.cwd', async () => ok(live.root))
  on('session.root', async () => ok(live.root))
  on('session.repo', async () => ok(opts.repo === undefined || opts.repo === null ? null : { root: opts.repo, remote: null, internal: false, name: null }))
  on('session.messages', async () => ok(MESSAGES))
  on('settings.read', async () => ok({ permissions: { additionalDirectories: ['G:\\Projects\\shared'] } }))
  on('fs.exists', async ($, e) => ok(norm(e.path) in files))
  on('fs.read', async ($, e) => ok(files[norm(e.path)] ?? ''))
  on('fs.write', async ($, e) => {
    files[norm(e.path)] = e.text
    mtimes[norm(e.path)] = clock.now()
    return VOID
  })
  on('fs.stat', async ($, e) => {
    const p = norm(e.path)
    if (opts.gitFile && p.endsWith('/.git')) return ok({ kind: 'file', size: 10, mtimeMs: NOW, isLink: false })
    return (p in files ? ok({ kind: 'file', size: files[p]?.length ?? 0, mtimeMs: mtimes[p] ?? NOW, isLink: false }) : { deny: 'missing' }) as never
  })
  on('command.register', async ($, e) => ok({ command: e.name }))
  on('tool.register', async ($, e) => ok({ tool: `mcp__context-handoff__${e.name}` }))
  on('command.run', async ($, e) => {
    commands.push(e.command)
    if (opts.commandRun) return opts.commandRun(e.command) as never
    if (e.command === 'clear' && engine !== undefined) {
      live.turns = 0
      await engine.session.end({ reason: 'clear', sessionId: 'sess-1234abcd-old', resume: undefined } as never)
    }
    return {} as never
  })
  on('prompt.submit', async ($, e) => {
    if (opts.isSubmitHeldUntilStart) await started
    const o = e as { origin?: { asUser?: boolean }; asUser?: boolean }
    submitted.push({ text: e.text, asUser: o.asUser ?? o.origin?.asUser })
    return { text: e.text } as never
  })
  on('ui.toast', async () => VOID)
  on('ui.log', async () => VOID)
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.attach', async () => ({}) as never)
  on('session.measure', async ($, e) => ({ changed: e.changed }) as never)
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }) as never)
  on('turn.start', async ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('prompt.context', async ($, e) => ({ blocks: e.blocks }) as never)
  on('session.compact', async ($, e) => {
    compactions.push(e.instructions)
    return { messages: e.messages } as never
  })
  const modSubmits = () => submitted.filter(s => s.asUser === true)
  return { clock, files, mtimes, live, forks, submitted, modSubmits, commands, compactions, bind, store, markStarted }
}

type W = ReturnType<typeof world>

async function start($: Engine, w: W) {
  w.bind($)
  await $.session.start({ source: 'startup', cwd: w.live.root, surface: null, isInteractive: false } as never)
  w.markStarted()
  await w.clock.settle()
}

async function measure($: Engine, w: W, tokens: number) {
  w.live.tokens = tokens
  w.live.turns += 1
  await $.session.measure({ context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) }, rateLimits: [], changed: ['context'] } as never)
  await w.clock.settle()
}

let turnNo = 0
async function turnBegins($: Engine, text = 'work') {
  turnNo += 1
  const turnId = `t${turnNo}`
  await $.turn.start({ text, turnId })
  return turnId
}
async function turnEnds($: Engine, w: W, turnId: string, reason = 'answer') {
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: reason === 'aborted', turnId, reason } as never)
  await w.clock.settle()
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never

async function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'context-handoff', surface, component: 'AbovePrompt', props: BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const found = await ui.findAll({ type: 'Button' })
  const buttons = found.map(b => b.key ?? '')
  const labels = found.map(b => String(b.props.label ?? ''))
  const hotkeys = found.map(b => b.props.hotkey)
  const boxes = (await ui.findAll({ type: 'Box' })).map(b => b.props)
  await ui.unmount()
  return { texts, buttons, labels, hotkeys, boxes, text: texts.join(' | ') }
}

async function press($: Engine, w: W, key: string, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'context-handoff', surface, component: 'AbovePrompt', props: BAND })
  await ui.press({ key })
  await ui.unmount()
  await w.clock.settle()
}

const cmd = ($: Engine, args: string) => $.command.run({ command: 'handoff', args, origin: { kind: 'composer' }, presentation: 'text' } as never) as Promise<{ text?: string }>
const typed = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
const injected = async ($: Engine) => ((await $.prompt.context({ blocks: [] } as never)) as unknown as { blocks: { name: string; text: string }[] }).blocks

const HANDOFF = 'c:/work/proj/.context/handoff.md'
const KEY = 'pending:c:/work/proj'

function deferred<T>() {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

// ---------------------------------------------------------------- core

describe('core', () => {
  test('thresholds and paths', async () => {
    expect(offerLine('auto', 967_000)).toBe(200_000)
    expect(offerLine('auto', 160_000)).toBe(136_000)
    expect(offerLine('300k', 967_000)).toBe(300_000)
    expect(offerLine('90%', 967_000)).toBe(870_300)
    expect(offerLine('2m', 967_000)).toBe(918_650)
    expect(nextOffer('auto', 967_000, 350_000)).toBe(350_000)
    expect(parseAt('300K')).toEqual({ kind: 'tokens', tokens: 300_000 })
    expect(parseAt('85 %')).toEqual({ kind: 'percent', percent: 85 })
    expect(parseAt('5k')).toBeUndefined()
    expect(parseAt('99%')).toBeUndefined()
    expect(tokensText(212_345, 'he')).toBe('212 אלף')
    expect(tokensText(1_234_567, 'en')).toBe('1.2M')
    expect(normPath('C:\\work\\proj\\')).toBe('C:/work/proj')
    expect(normPath('C:\\')).toBe('C:/')
    expect(normPath('\\\\nas\\work\\proj')).toBe('//nas/work/proj')
    expect(joinPath('C:\\', '.context/HANDOFF.md')).toBe('C:/.context/HANDOFF.md')
  })

  test('markers with decoration still parse; STATUS is read only from the head', async () => {
    const decorated = '**STATUS**: WAIT\n**=== GOAL ===**\nship it\n## === Next Steps ===\n1. x\n`=== IN_PROGRESS ===`\n- [ ] build status: continue on CI\n=== END ==='
    const p = parseHandoff(decorated)
    expect(p.status).toBe('WAIT')
    expect(p.slots.GOAL).toBe('ship it')
    expect(p.slots.NEXT_STEPS).toBe('1. x')
    expect(p.isComplete).toBe(true)
    expect(parseHandoff(GOOD).status).toBe('CONTINUE')
    expect(parseHandoff('=== GOAL ===\ng\n==== FAILURES ====\nlog\n=== NEXT_STEPS ===\n1. y\n=== END ===').slots.GOAL).toContain('==== FAILURES ====')
    expect(isUsable(parseHandoff('STATUS: WAIT\n=== GOAL ===\ndone\n=== NEXT_STEPS ===\nnone\n=== END ==='))).toBe(true)
    expect(isUsable(parseHandoff('STATUS: CONTINUE\n=== GOAL ===\ng\n=== NEXT_STEPS ===\nnone\n=== END ==='))).toBe(false)
    expect(readOwnFile('# Handoff: ship v2\n\nSTATUS: WAIT\n\n## In Progress\n- build status: continue').status).toBe('WAIT')
  })

  test('the file has every section, the workspace and the edited files', async () => {
    const facts: Facts = {
      now: NOW, sessionId: 'sess-1234abcd-old', tokens: 212_000, compactAt: 967_000,
      cwd: 'C:\\work\\proj', root: 'C:\\work\\proj', path: 'C:/work/proj/.context/HANDOFF.md',
      folders: ['G:\\Projects\\shared'], addedFolders: ['D:\\extra'], editedFiles: ['C:\\work\\proj\\a.ts'], lastUserText: '', isLastUserTextSeen: false,
    }
    const file = buildFile(parseHandoff(GOOD), facts)
    for (const h of ['# Handoff: Build the context-handoff mod.', '## Goal', '## Constraints and Preferences', '## Completed', '## In Progress', '## Key Decisions', '## Known Issues', '## Next Steps', '## Important Files', '## Environment', '## Workspace']) {
      expect(file).toContain(h)
    }
    expect(file).toContain('`G:\\Projects\\shared`')
    expect(file).toContain('`D:\\extra`')
    expect(file).toContain('`C:\\work\\proj\\a.ts`')
    expect(file).toContain('claude --resume sess-1234abcd-old')
    expect(buildFile(parseHandoff(CUT), facts)).toContain('cut short')
    const block = factsBlock({ ...facts, previous: '# Handoff: old\nold body', previousMtime: NOW - 86_400_000 })
    expect(block.indexOf('--- END OF MOD FACTS ---')).toBeLessThan(block.indexOf('--- OLDER NOTE'))
    expect(block).toContain('old body')
  })

  test('the last typed text skips the mod\'s own prompts, tags and summaries, not a pasted log', async () => {
    expect(editedFiles(MESSAGES)).toEqual(['C:\\work\\proj\\hooks\\register.tsx', 'C:\\work\\proj\\hooks\\core.ts'])
    expect(lastUserText(MESSAGES)).toBe('תבנה את ה-mod')
    const more = [...MESSAGES, { role: 'user', text: '[ERROR] build failed at step 3', toolUses: [] }, { role: 'user', text: 'Continue the work from the previous session. Its context...', toolUses: [] }, { role: 'user', text: 'This session is being continued from a previous conversation', toolUses: [] }]
    expect(lastUserText(more)).toBe('[ERROR] build failed at step 3')
  })

  test('/handoff arguments', async () => {
    expect(parseCommand('')).toEqual({ kind: 'start', mode: 'switch' })
    expect(parseCommand('write')).toEqual({ kind: 'start', mode: 'write' })
    expect(parseCommand('resume')).toEqual({ kind: 'resume' })
    expect(parseCommand('at 300K')).toEqual({ kind: 'at', at: '300k' })
    expect(parseCommand('at banana')).toEqual({ kind: 'bad', why: 'at' })
    expect(parseCommand('off')).toEqual({ kind: 'enable', enabled: false })
    expect(parseCommand('lang he')).toEqual({ kind: 'lang', language: 'he' })
    expect(parseCommand('dance')).toEqual({ kind: 'bad', why: 'unknown' })
  })

  test('Hebrew band words hold no Latin letters, except a part that is only a command', async () => {
    const he = WORDS.he
    const every = Object.values(he).flatMap(v => (typeof v === 'function' ? [(v as (...a: unknown[]) => string | string[])(212_000, false)].flat() : [v].flat()))
    for (const s of every) {
      if (/^\/[a-z]+$/.test(String(s))) continue
      expect(String(s)).not.toMatch(/[A-Za-z]/)
    }
    const all: string[] = [
      ...he.offer(212_000), ...he.offerUrgent(930_000), he.go, he.later, ...he.writing, ...he.writingOnly, he.cancel,
      ...he.switching, ...he.waitingForTurn, ...he.clearNeeded, he.retryClear, he.keep, ...he.saved, he.switchNow, he.close,
      ...he.failed('שגיאת שרת 500'), he.retry, he.askSession, ...he.sessionWriting, he.stopSwitch,
      ...he.pickup('לפני שעה', false), ...he.pickup('לפני שעה', true), he.pickupGo, he.pickupIgnore, ...he.cancelledByMessage,
    ]
    for (const s of all) {
      if (/^\/[a-z]+$/.test(s)) continue
      expect(s).not.toMatch(/[A-Za-z]/)
    }
  })

  test('a fresh switch carries on; a picked-up handoff checks first and waits', async () => {
    const p: Pending = { path: 'C:/p/.context/HANDOFF.md', text: 'x', goal: 'g', status: 'CONTINUE', tokens: 212_000, fromSession: 's', createdAt: NOW, state: 'switching' }
    expect(resumePrompt(p, 'en', true)).toContain('carry straight on')
    expect(resumePrompt(p, 'en', false)).toContain('stop and wait')
    expect(resumePrompt(p, 'en', false)).toContain('which next steps are already done')
    expect(resumePrompt(p, 'he', true)).toContain('המשך ישר לצעד הבא')
    expect(resumePrompt({ ...p, status: 'WAIT' }, 'he', true)).toContain('עצור וחכה לי')
  })
})

// ---------------------------------------------------------------- the main flow, on both surfaces

for (const surface of ['terminal', 'desktop'] as const) {
  describe(surface, () => {
    test('nothing below the line; the offer past it, with no digit hotkeys; Later moves it on by 150K', async ($, on) => {
      const w = world(on, { surface })
      await start($, w)
      await measure($, w, 150_000)
      expect((await band($, surface)).buttons).toEqual([])
      await measure($, w, 210_000)
      const offer = await band($, surface)
      expect(offer.buttons).toEqual(['handoff-go', 'handoff-later'])
      expect(offer.hotkeys).toEqual([undefined, undefined])
      await press($, w, 'handoff-later', surface)
      expect((await band($, surface)).buttons).toEqual([])
      await measure($, w, 300_000)
      expect((await band($, surface)).buttons).toEqual([])
      await measure($, w, 362_000)
      expect((await band($, surface)).buttons).toEqual(['handoff-go', 'handoff-later'])
    })

    test('accept: the fork writes, the old file is archived, /clear runs, and the next conversation starts from it', async ($, on) => {
      const w = world(on, { surface, files: { 'C:\\work\\proj\\.context\\HANDOFF.md': '# Handoff: older\nold text' } })
      await start($, w)
      await typed($, 'please finish the mod')
      await measure($, w, 230_000)
      await press($, w, 'handoff-go', surface)
      await w.clock.advance(1_000)

      expect(w.forks.length).toBe(1)
      expect(w.forks[0]).toContain('--- MOD FACTS ---')
      expect(w.forks[0]).toContain('(verbatim, as typed)\n<<<\nplease finish the mod')
      expect(w.forks[0]).toContain('G:\\Projects\\shared')
      expect(w.forks[0]).toContain('--- OLDER NOTE')
      expect(w.forks[0]).toContain('will be cleared right after you answer')
      expect(w.files[HANDOFF]).toContain('## Next Steps')
      const archived = Object.keys(w.files).filter(k => k.includes('/.context/handoff-archive/handoff-'))
      expect(archived.length).toBe(1)
      expect(w.files[archived[0] as string]).toContain('old text')
      expect(w.commands).toEqual(['clear'])

      const sent = w.modSubmits()
      expect(sent.length).toBe(1)
      expect(sent[0]?.text).toContain('.context/HANDOFF.md')
      expect(sent[0]?.text).toContain(surface === 'desktop' ? 'המשך ישר לצעד הבא' : 'carry straight on')
      const blocks = await injected($)
      expect(blocks.map(b => b.name)).toEqual(['handoff'])
      expect(blocks[0]?.text).toContain('## Key Decisions')
      expect(await injected($)).toEqual([])
      expect((await band($, surface)).buttons).toEqual([])
    })
  })
}

test('the desktop band reads right to left, in Hebrew, part by part', async ($, on) => {
  const w = world(on, { surface: 'desktop', commandRun: async () => ({}) })
  await start($, w)
  await measure($, w, 230_000)
  const he = await band($, 'desktop')
  expect(he.text).toContain('230 אלף טוקנים')
  expect(he.text).not.toMatch(/[A-Za-z]/)
  expect(he.labels.join(' ')).not.toMatch(/[A-Za-z]/)
  expect(he.boxes.some(b => b.flexDirection === 'row-reverse')).toBe(true)
  await press($, w, 'handoff-go', 'desktop')
  const waiting = await band($, 'desktop')
  expect(waiting.texts).toContain('/clear')
  expect(waiting.texts.filter(t => t !== '/clear').join(' ')).not.toMatch(/[A-Za-z]/)
  expect((await band($, 'terminal')).text).toContain('Type')
})

// ---------------------------------------------------------------- failures

test('a failing fork shows the reason and Try again; the retry after a server error is not asked to be tighter', async ($, on) => {
  const w = world(on, { replies: ['error', 'error', GOOD], seed: { lastLang: 'he' } })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  expect(w.forks.length).toBe(2)
  expect(w.forks[1]).not.toContain('cut off')
  const failed = await band($)
  expect(failed.text).toContain('server error 500')
  expect(failed.buttons).toEqual(['handoff-retry', 'handoff-ask-session', 'handoff-close'])
  const he = await band($, 'desktop')
  expect(he.text).toContain('שגיאת שרת 500')
  await press($, w, 'handoff-retry')
  expect(w.files[HANDOFF]).toContain('## Goal')
  expect(w.commands).toEqual(['clear'])
})

test('cut short: asked again tighter, and a complete reply wins; cut twice is still saved and marked', async ($, on) => {
  const w = world(on, { replies: [CUT, GOOD, CUT, CUT] })
  await start($, w)
  await measure($, w, 230_000)
  await cmd($, 'write')
  await w.clock.settle()
  expect(w.forks[1]).toContain('cut off')
  expect(w.files[HANDOFF]).not.toContain('cut short')
  await press($, w, 'handoff-close')
  await cmd($, 'write')
  await w.clock.settle()
  expect(w.files[HANDOFF]).toContain('cut short')
})

test('an unreadable reply is asked again with a format reminder', async ($, on) => {
  const w = world(on, { replies: ['Here is the handoff: we built a mod.', GOOD] })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  expect(w.forks[1]).toContain('could not be read')
  expect(w.commands).toEqual(['clear'])
})

test('nothing to fork yet: one try, and only Close', async ($, on) => {
  const w = world(on, { replies: ['nothing'] })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  expect(w.forks.length).toBe(1)
  const b = await band($)
  expect(b.text).toContain('no conversation to summarize')
  expect(b.buttons).toEqual(['handoff-close'])
})

test('/handoff in a conversation with no replies does nothing and says why', async ($, on) => {
  const w = world(on)
  await start($, w)
  const reply = await cmd($, '')
  expect(String(reply.text)).toContain('no replies')
  expect(w.forks.length).toBe(0)
})

test('a network folder fails clearly, without writing anywhere', async ($, on) => {
  const w = world(on, { root: '\\\\nas\\work\\proj' })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  expect(w.forks.length).toBe(0)
  expect(Object.keys(w.files)).toEqual([])
  expect((await band($)).text).toContain('network folder')
})

// ---------------------------------------------------------------- the clear

test('a refused /clear asks for it at once; a /clear typed by hand still carries on', async ($, on) => {
  const w = world(on, { commandRun: async () => ({}) })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  const waiting = await band($)
  expect(waiting.text).toContain('Type | /clear')
  expect(waiting.buttons).toEqual(['handoff-retry-clear', 'handoff-keep'])
  await $.session.end({ reason: 'clear', sessionId: 'sess-1234abcd-old', resume: undefined } as never)
  await w.clock.advance(1_000)
  expect(w.modSubmits().length).toBe(1)
})

test('a /clear that never settles shows the hint after 15 seconds', async ($, on) => {
  const w = world(on, { commandRun: () => new Promise<never>(() => {}) })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  await w.clock.advance(14_000)
  expect((await band($)).text).toContain('Clearing')
  await w.clock.advance(1_000)
  expect((await band($)).text).toContain('Type | /clear')
})

test('Keep it for later, or typing on, leaves the conversation and keeps the handoff for a later one', async ($, on) => {
  const w = world(on, { commandRun: async () => ({}) })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  await typed($, 'actually, one more thing')
  const cancelled = await band($)
  expect(cancelled.text).toContain('cancelled')
  expect(cancelled.buttons).toEqual(['handoff-close'])
  expect(w.commands).toEqual(['clear'])
  const stored = w.store.get(KEY) as Pending
  expect(stored.state).toBe('written')
  expect(stored.isOutdated).toBe(true)
})

test('the fork finishing while a turn runs: no /clear mid-turn, and the handoff is written again to cover that turn', async ($, on) => {
  const first = deferred<unknown>()
  let calls = 0
  const w = world(on, {
    fork: async () => {
      calls += 1
      if (calls === 1) return first.promise
      return ok({ isAnswered: true, text: SECOND, usage: {} })
    },
  })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  const t = await turnBegins($, 'a background task notification')
  first.resolve(ok({ isAnswered: true, text: GOOD, usage: {} }))
  await w.clock.settle()
  expect(w.commands).toEqual([])
  expect((await band($)).text).toContain('current turn ends')
  await turnEnds($, w, t)
  await w.clock.advance(1_500)
  await w.clock.advance(1_500)
  expect(w.forks.length).toBe(2)
  expect(w.files[HANDOFF]).toContain('Ship version two.')
  expect(w.commands).toEqual(['clear'])
})

// ---------------------------------------------------------------- cancel

test('a message while the switch is written cancels it, and a later start never revives the old run', async ($, on) => {
  const f1 = deferred<unknown>()
  const f2 = deferred<unknown>()
  let calls = 0
  const w = world(on, {
    fork: async () => {
      calls += 1
      return calls === 1 ? f1.promise : f2.promise
    },
  })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  expect((await band($)).text).toContain('Writing a full handoff')
  await typed($, 'wait, one more thing')
  expect((await band($)).text).toContain('cancelled')
  await cmd($, 'write')
  await w.clock.settle()
  f1.resolve(ok({ isAnswered: true, text: GOOD, usage: {} }))
  await w.clock.settle()
  expect(w.commands).toEqual([])
  expect(w.files[HANDOFF]).toBeUndefined()
  f2.resolve(ok({ isAnswered: true, text: SECOND, usage: {} }))
  await w.clock.settle()
  expect(w.files[HANDOFF]).toContain('Ship version two.')
  expect(w.commands).toEqual([])
  expect((await band($)).buttons).toEqual(['handoff-switch-now', 'handoff-close'])
})

test('a message does not cancel a write-only run', async ($, on) => {
  const f1 = deferred<unknown>()
  const w = world(on, { fork: () => f1.promise })
  await start($, w)
  await measure($, w, 230_000)
  await cmd($, 'write')
  await w.clock.settle()
  await typed($, 'keep going meanwhile')
  f1.resolve(ok({ isAnswered: true, text: GOOD, usage: {} }))
  await w.clock.settle()
  expect(w.files[HANDOFF]).toContain('## Goal')
  expect((await band($)).buttons).toEqual(['handoff-switch-now', 'handoff-close'])
})

// ---------------------------------------------------------------- write, switch, pick up

test('/handoff write saves and stays; Switch now reuses that file', async ($, on) => {
  const w = world(on)
  await start($, w)
  await measure($, w, 120_000)
  const reply = await cmd($, 'write')
  await w.clock.settle()
  expect(String(reply.text)).toContain('HANDOFF.md')
  expect(w.forks[0]).toContain('This conversation goes on for now')
  expect(w.forks[0]).not.toContain('will be cleared')
  expect((await band($)).text).toContain('.context/HANDOFF.md')
  expect(w.files[HANDOFF]).toContain('## Goal')
  expect(w.commands).toEqual([])
  await press($, w, 'handoff-switch-now')
  await w.clock.advance(1_000)
  expect(w.forks.length).toBe(1)
  expect(w.commands).toEqual(['clear'])
  expect(w.modSubmits().length).toBe(1)
})

test('/handoff write, then a /clear typed by hand: the cleared conversation is offered the handoff', async ($, on) => {
  const w = world(on)
  await start($, w)
  await measure($, w, 120_000)
  await cmd($, 'write')
  await w.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'sess-1234abcd-old', resume: undefined } as never)
  await w.clock.settle()
  expect((await band($)).buttons).toEqual(['handoff-pickup', 'handoff-ignore'])
})

test('/handoff while Claude works starts once the session stays quiet, after any queued turn', async ($, on) => {
  const w = world(on)
  await start($, w)
  await measure($, w, 120_000)
  const t1 = await turnBegins($)
  const reply = await cmd($, '')
  expect(String(reply.text)).toContain('finishes the current turn')
  await turnEnds($, w, t1)
  const t2 = await turnBegins($, 'a queued message')
  await w.clock.advance(1_500)
  expect(w.forks.length).toBe(0)
  await turnEnds($, w, t2)
  await w.clock.advance(1_500)
  expect(w.forks.length).toBe(1)
  expect(w.commands).toEqual(['clear'])
})

const waiting = (over: Partial<Pending> = {}): Pending => ({ path: 'C:/work/proj/.context/HANDOFF.md', text: '# Handoff: finish the mod\nbody', goal: 'finish the mod', status: 'CONTINUE', tokens: 230_000, fromSession: 'old', createdAt: NOW - 3_600_000, state: 'written', ...over })

test('a fresh conversation is offered a waiting handoff; Continue checks first and waits, and the handoff is attached', async ($, on) => {
  const w = world(on, { seed: { [KEY]: waiting() }, surface: 'desktop' })
  await start($, w)
  const offered = await band($, 'desktop')
  expect(offered.text).toContain('לפני שעה')
  expect(offered.text).toContain('finish the mod')
  await press($, w, 'handoff-pickup', 'desktop')
  const sent = w.modSubmits()
  expect(sent.length).toBe(1)
  expect(sent[0]?.text).toContain('עצור וחכה לי')
  expect(sent[0]?.text).toContain('בדוק בקבצים')
  expect((await injected($)).map(b => b.name)).toEqual(['handoff'])
  expect((w.store.get(KEY) as Pending).state).toBe('consumed')
})

test('the file on disk wins over the stored copy when picking up', async ($, on) => {
  const w = world(on, { seed: { [KEY]: waiting() }, files: { 'C:\\work\\proj\\.context\\HANDOFF.md': '# Handoff: edited by hand\nSTATUS: WAIT\nnew body' } })
  await start($, w)
  await press($, w, 'handoff-pickup')
  expect((await injected($))[0]?.text).toContain('new body')
})

test('a handoff is taken once: a second conversation cannot take it again', async ($, on) => {
  const w = world(on, { seed: { [KEY]: waiting() } })
  await start($, w)
  w.store.set(KEY, { ...waiting(), state: 'consumed', consumedBy: 'another' })
  await press($, w, 'handoff-pickup')
  expect(w.modSubmits().length).toBe(0)
  const taken = await band($)
  expect(taken.text).toContain('already picked up in another conversation')
  expect(taken.buttons).toEqual(['handoff-close'])
})

test('Ignore dismisses a waiting handoff for good', async ($, on) => {
  const w = world(on, { seed: { [KEY]: waiting() } })
  await start($, w)
  await press($, w, 'handoff-ignore')
  expect((w.store.get(KEY) as Pending).state).toBe('dismissed')
  await start($, w)
  expect((await band($)).buttons).toEqual([])
})

test('a conversation that already has turns is not offered a waiting handoff', async ($, on) => {
  const w = world(on, { seed: { [KEY]: waiting() }, turns: 4 })
  await start($, w)
  expect((await band($)).buttons).toEqual([])
})

test('a new process right after the mod\'s own /clear offers the handoff; one click carries straight on', async ($, on) => {
  const w = world(on, { seed: { [KEY]: waiting({ state: 'switching', switchingAt: NOW - 40_000, clearIssuedAt: NOW - 30_000 }) } })
  await start($, w)
  expect(w.modSubmits().length).toBe(0)
  await press($, w, 'handoff-pickup')
  expect(w.modSubmits()[0]?.text).toContain('carry straight on')
})

test('an abandoned switch (long ago, /clear never issued) is only offered', async ($, on) => {
  const w = world(on, { seed: { [KEY]: waiting({ state: 'switching', switchingAt: NOW - 20 * 60_000 }) } })
  await start($, w)
  expect(w.modSubmits().length).toBe(0)
  expect((await band($)).buttons).toEqual(['handoff-pickup', 'handoff-ignore'])
})

test('another conversation\'s live switch is neither offered nor taken here', async ($, on) => {
  const w = world(on, { seed: { [KEY]: waiting({ state: 'switching', switchingAt: NOW - 10_000 }) } })
  await start($, w)
  expect(w.modSubmits().length).toBe(0)
  expect((await band($)).buttons).toEqual([])
  expect((w.store.get(KEY) as Pending).state).toBe('switching')
})

test('with nobody attending (a headless run), a mid-switch entry is not taken', async ($, on) => {
  const w = world(on, { seed: { [KEY]: waiting({ state: 'switching', switchingAt: NOW - 40_000, clearIssuedAt: NOW - 30_000 }) }, surface: 'none', attended: false })
  await start($, w)
  expect(w.modSubmits().length).toBe(0)
  expect((w.store.get(KEY) as Pending).state).toBe('switching')
})

// ---------------------------------------------------------------- offers over time

test('a standing offer becomes the urgent one at 95%', async ($, on) => {
  const w = world(on)
  await start($, w)
  await measure($, w, 230_000)
  await measure($, w, 600_000)
  expect((await band($)).text).toContain('Continue from this point')
  await measure($, w, 930_000)
  expect((await band($)).text).toContain('nearly full')
})

test('a compaction starts the offers over; a precompute does not', async ($, on) => {
  const w = world(on)
  await start($, w)
  await measure($, w, 930_000)
  await press($, w, 'handoff-later')
  await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  await measure($, w, 940_000)
  expect((await band($)).buttons).toEqual([])
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  await measure($, w, 60_000)
  expect((await band($)).buttons).toEqual([])
  await measure($, w, 210_000)
  expect((await band($)).text).toContain('Continue from this point')
})

test('auto-compaction is steered once; a /compact you type is left alone', async ($, on) => {
  const w = world(on)
  await start($, w)
  const msgs = [{ role: 'user', text: 'hi', toolUses: [] }]
  await $.session.compact({ trigger: 'auto', instructions: 'keep the tests', messages: msgs } as never)
  await $.session.compact({ trigger: 'manual', instructions: 'mine', messages: msgs } as never)
  expect(w.compactions[0]).toContain('keep the tests')
  expect(w.compactions[0]).toContain('[context-handoff]')
  expect(w.compactions[1]).toBe('mine')
  await $.session.compact({ trigger: 'auto', instructions: w.compactions[0], messages: msgs } as never)
  expect(w.compactions[2]).toBe(w.compactions[0])
})

test('/handoff at, off and status; raising the line takes the band down', async ($, on) => {
  const w = world(on)
  await start($, w)
  await measure($, w, 250_000)
  expect((await band($)).buttons).toEqual(['handoff-go', 'handoff-later'])
  const at = await cmd($, 'at 300k')
  expect(String(at.text)).toContain('300K tokens')
  expect((await band($)).buttons).toEqual([])
  await measure($, w, 310_000)
  expect((await band($)).buttons).toEqual(['handoff-go', 'handoff-later'])
  await cmd($, 'off')
  expect((await band($)).buttons).toEqual([])
  await measure($, w, 400_000)
  expect((await band($)).buttons).toEqual([])
  const status = String((await cmd($, 'status')).text)
  expect(status).toContain('400K tokens')
  expect(status).toContain('Automatic offer: off')
})

test('/handoff replies in Hebrew in the desktop app, Hebrew first on each line', async ($, on) => {
  const w = world(on, { surface: 'desktop' })
  await start($, w)
  const help = String((await cmd($, 'help')).text)
  for (const line of help.split('\n')) expect(line).toMatch(/^[\u0590-\u05FF]/)
})

test('/resume or /branch drops a running fork', async ($, on) => {
  const f1 = deferred<unknown>()
  const w = world(on, { fork: () => f1.promise })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  await $.session.end({ reason: 'resume', sessionId: 'sess-1234abcd-old', resume: undefined } as never)
  f1.resolve(ok({ isAnswered: true, text: GOOD, usage: {} }))
  await w.clock.settle()
  expect(w.commands).toEqual([])
  expect(w.files[HANDOFF]).toBeUndefined()
})

test('in a worktree, the handoff goes to the main checkout', async ($, on) => {
  const w = world(on, { root: 'C:\\work\\proj\\.claude\\worktrees\\wt1', repo: 'C:\\work\\proj', gitFile: true })
  await start($, w)
  await measure($, w, 230_000)
  await cmd($, 'write')
  await w.clock.settle()
  expect(w.files[HANDOFF]).toContain('worktree')
  expect(Object.keys(w.files).some(k => k.includes('/worktrees/wt1/.context/'))).toBe(false)
})

test('another session\'s /handoff off is not undone by this one', async ($, on) => {
  const w = world(on)
  await start($, w)
  w.store.set('settings', { enabled: false })
  await cmd($, 'at 300k')
  expect((w.store.get('settings') as { enabled: boolean }).enabled).toBe(false)
})

// ---------------------------------------------------------------- the fallback

test('Have Claude write it: an interrupted write turn only saves, it never switches', async ($, on) => {
  const w = world(on, { replies: ['error', 'error'] })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  await press($, w, 'handoff-ask-session')
  const asked = w.modSubmits()
  expect(asked[0]?.text.startsWith('[context-handoff] Write the handoff')).toBe(true)
  const t = await turnBegins($, asked[0]?.text ?? '')
  await w.clock.advance(5_000)
  w.files[HANDOFF] = '# Handoff: written by the session\nSTATUS: WAIT\n## Goal\ng'
  w.mtimes[HANDOFF] = w.clock.now()
  await turnEnds($, w, t, 'aborted')
  expect(w.commands).toEqual([])
  expect((await band($)).buttons).toEqual(['handoff-switch-now', 'handoff-close'])
})

test('Have Claude write it: a finished write turn switches', async ($, on) => {
  const w = world(on, { replies: ['error', 'error'] })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  await press($, w, 'handoff-ask-session')
  const t = await turnBegins($, w.modSubmits()[0]?.text ?? '')
  await w.clock.advance(5_000)
  w.files[HANDOFF] = '# Handoff: written by the session\nSTATUS: CONTINUE\n## Goal\ng'
  w.mtimes[HANDOFF] = w.clock.now()
  await turnEnds($, w, t)
  await w.clock.advance(1_000)
  expect(w.commands).toEqual(['clear'])
  expect(w.modSubmits().length).toBe(2)
})

// ---------------------------------------------------------------- the second review

test('Try clearing again re-arms the watchdog; refused twice, it asks for /clear by hand, without a retry button', async ($, on) => {
  const w = world(on, { commandRun: async () => ({}) })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  expect((await band($)).buttons).toEqual(['handoff-retry-clear', 'handoff-keep'])
  await press($, w, 'handoff-retry-clear')
  const stuck = await band($)
  expect(stuck.text).toContain('does not work here')
  expect(stuck.buttons).toEqual(['handoff-keep'])
  expect(w.commands).toEqual(['clear', 'clear'])
})

test('a /clear that never settles: no second /clear, only Keep', async ($, on) => {
  const w = world(on, { commandRun: () => new Promise<never>(() => {}) })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  await w.clock.advance(15_000)
  const b = await band($)
  expect(b.buttons).toEqual(['handoff-keep'])
  expect(w.commands).toEqual(['clear'])
})

test('Keep while the mod\'s /clear is on its way: if it lands anyway, the new conversation checks first and waits', async ($, on) => {
  const w = world(on, { commandRun: () => new Promise<never>(() => {}) })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  await w.clock.advance(15_000)
  await press($, w, 'handoff-keep')
  expect((w.store.get(KEY) as Pending).state).toBe('written')
  await $.session.end({ reason: 'clear', sessionId: 'sess-1234abcd-old', resume: undefined } as never)
  await w.clock.advance(1_000)
  const sent = w.modSubmits()
  expect(sent.length).toBe(1)
  expect(sent[0]?.text).toContain('stop and wait')
  expect(sent[0]?.text).toContain('which next steps are already done')
})

test('a turn between the handoff and a /clear typed by hand: the next conversation checks first and waits', async ($, on) => {
  const w = world(on, { commandRun: async () => ({}) })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  const t = await turnBegins($, 'a background task notification')
  await turnEnds($, w, t)
  await $.session.end({ reason: 'clear', sessionId: 'sess-1234abcd-old', resume: undefined } as never)
  await w.clock.advance(1_000)
  expect(w.modSubmits()[0]?.text).toContain('stop and wait')
})

test('a message typed while the switch waits for the turn to end keeps the conversation', async ($, on) => {
  const first = deferred<unknown>()
  const w = world(on, { fork: () => first.promise })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  const t = await turnBegins($, 'a background task notification')
  first.resolve(ok({ isAnswered: true, text: GOOD, usage: {} }))
  await w.clock.settle()
  expect((await band($)).text).toContain('current turn ends')
  await typed($, 'one more thing first')
  await turnEnds($, w, t)
  await w.clock.advance(3_000)
  expect(w.commands).toEqual([])
  expect((w.store.get(KEY) as Pending).state).toBe('written')
})

test('a handoff the mod wrote, edited by hand, keeps its CONTINUE status', async () => {
  const facts: Facts = {
    now: NOW, sessionId: 'sess-1234abcd-old', tokens: 212_000, compactAt: 967_000,
    cwd: 'C:\\work\\proj', root: 'C:\\work\\proj', path: 'C:/work/proj/.context/HANDOFF.md',
    folders: [], addedFolders: [], editedFiles: [], lastUserText: '', isLastUserTextSeen: false,
  }
  const file = buildFile(parseHandoff(GOOD), facts)
  const own = readOwnFile(`${file}\nan extra line the person added`)
  expect(own.status).toBe('CONTINUE')
  expect(own.hasStatus).toBe(true)
})

test('a skill given a task counts as the latest request; a bare command or /handoff does not', async ($, on) => {
  const w = world(on)
  await start($, w)
  await typed($, 'fix the login bug')
  await typed($, '/gsd-orchestration build the payments page')
  await typed($, '/handoff status')
  await typed($, '/compact')
  await measure($, w, 230_000)
  await cmd($, 'write')
  await w.clock.settle()
  expect(w.forks[0]).toContain('<<<\n/gsd-orchestration build the payments page\n>>>')
})

test('a /clear typed by hand forgets the last request of the cleared conversation', async ($, on) => {
  const w = world(on)
  await start($, w)
  await typed($, 'fix the login bug')
  await $.session.end({ reason: 'clear', sessionId: 'sess-1234abcd-old', resume: undefined } as never)
  await w.clock.settle()
  await measure($, w, 230_000)
  await cmd($, 'write')
  await w.clock.settle()
  expect(w.forks[0]).not.toContain('fix the login bug')
  expect(w.forks[0]).toContain('read back from the transcript')
})

test('/handoff replies hold no Latin letters in Hebrew, except commands, paths and numbers', async ($, on) => {
  const w = world(on, { surface: 'desktop' })
  await start($, w)
  await measure($, w, 120_000)
  const replies: string[] = []
  const t = await turnBegins($)
  replies.push(String((await cmd($, '')).text))
  await turnEnds($, w, t)
  replies.push(String((await cmd($, 'at 300k')).text), String((await cmd($, 'off')).text), String((await cmd($, 'on')).text), String((await cmd($, 'resume')).text))
  for (const r of replies) expect(r).not.toMatch(/[A-Za-z]/)
})

// ---------------------------------------------------------------- the second review, the hunters

test('background turns during every fork: one re-fork at most, then it clears, and the next conversation checks first', async ($, on) => {
  let calls = 0
  const w = world(on, {
    fork: async () => {
      calls += 1
      const t = await turnBegins($, `background ${calls}`)
      await turnEnds($, w, t)
      return ok({ isAnswered: true, text: GOOD, usage: {} })
    },
  })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  for (let i = 0; i < 6; i++) await w.clock.advance(1_500)
  expect(w.forks.length).toBe(2)
  expect(w.commands).toEqual(['clear'])
  await w.clock.advance(1_000)
  expect(w.modSubmits()[0]?.text).toContain('stop and wait')
})

test('a message typed while a re-fork is queued stands it down', async ($, on) => {
  const first = deferred<unknown>()
  const w = world(on, { fork: () => first.promise })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  const t = await turnBegins($, 'background')
  first.resolve(ok({ isAnswered: true, text: GOOD, usage: {} }))
  await w.clock.settle()
  await turnEnds($, w, t)
  // issueClear found the handoff stale and queued a re-fork; the person types before it starts
  const t2 = await turnBegins($, 'another background')
  await typed($, 'hold on')
  await turnEnds($, w, t2)
  await w.clock.advance(3_000)
  expect(w.forks.length).toBe(1)
  expect(w.commands).toEqual([])
})

test('/handoff from the clear-needed band sets the old switch aside first', async ($, on) => {
  let n = 0
  const w = world(on, { commandRun: async () => ({}), fork: async () => ok({ isAnswered: true, text: (n++ === 0 ? GOOD : SECOND), usage: {} }) })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  expect((await band($)).buttons).toEqual(['handoff-retry-clear', 'handoff-keep'])
  await cmd($, 'write')
  await w.clock.settle()
  const stored = w.store.get(KEY) as Pending
  expect(stored.state).toBe('written')
  expect(stored.goal).toContain('Ship version two')
})

test('a /clear typed while the handoff is written keeps it, and offers it in the new conversation', async ($, on) => {
  const first = deferred<unknown>()
  const w = world(on, { fork: () => first.promise })
  await start($, w)
  await measure($, w, 230_000)
  await cmd($, 'write')
  await w.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'sess-1234abcd-old', resume: undefined } as never)
  await w.clock.settle()
  first.resolve(ok({ isAnswered: true, text: GOOD, usage: {} }))
  await w.clock.settle()
  expect(w.files[HANDOFF]).toContain('## Goal')
  expect((w.store.get(KEY) as Pending).state).toBe('written')
  expect((await band($)).buttons).toEqual(['handoff-pickup', 'handoff-ignore'])
})

test('Try again pressed during a turn: the clear waits, and the handoff is written again to cover that turn', async ($, on) => {
  let calls = 0
  const w = world(on, { fork: async () => {
    calls += 1
    if (calls <= 2) return ok({ isAnswered: false, reason: 'api-error', status: 500, error: 'x', usage: {} })
    return ok({ isAnswered: true, text: calls === 3 ? GOOD : SECOND, usage: {} })
  } })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  const t = await turnBegins($, 'background')
  await press($, w, 'handoff-retry')
  expect(w.commands).toEqual([])
  await turnEnds($, w, t)
  await w.clock.advance(1_500)
  await w.clock.advance(1_500)
  expect(w.forks.length).toBe(4)
  expect(w.files[HANDOFF]).toContain('Ship version two.')
  expect(w.commands).toEqual(['clear'])
})

test('Have Claude write it: found by the file even when the turn is not recognised, and Cancel is always there', async ($, on) => {
  const w = world(on, { replies: ['error', 'error'] })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  await press($, w, 'handoff-ask-session')
  expect((await band($)).buttons).toEqual(['handoff-stop-switch', 'handoff-cancel-write'])
  const t = await turnBegins($, 'some other prompt first')
  await w.clock.advance(5_000)
  w.files[HANDOFF] = '# Handoff: written by the session\nSTATUS: WAIT\n## Goal\ng'
  w.mtimes[HANDOFF] = w.clock.now()
  await turnEnds($, w, t)
  await w.clock.advance(1_000)
  expect(w.commands).toEqual(['clear'])
})

test('Have Claude write it: nothing after 10 minutes ends in the failed band', async ($, on) => {
  const w = world(on, { replies: ['error', 'error'] })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  await press($, w, 'handoff-ask-session')
  await w.clock.advance(10 * 60_000)
  expect((await band($)).text).toContain('the file was not written')
})

// ---------------------------------------------------------------- the second review, the desktop hunter

test('session.start never waits on a turn: a new process with a waiting handoff starts at once', async ($, on) => {
  const w = world(on, { isSubmitHeldUntilStart: true, seed: { [KEY]: waiting({ state: 'switching', switchingAt: NOW - 40_000, clearIssuedAt: NOW - 30_000 }) } })
  await start($, w)
  await press($, w, 'handoff-pickup')
  await w.clock.settle()
  expect(w.modSubmits().length).toBe(1)
})

test('Keep during a /clear that never settles: the next switch reuses that /clear, with no second one, and still offers the hint', async ($, on) => {
  let n = 0
  const w = world(on, { commandRun: () => new Promise<never>(() => {}), fork: async () => ok({ isAnswered: true, text: (n++ === 0 ? GOOD : SECOND), usage: {} }) })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  await w.clock.advance(15_000)
  await press($, w, 'handoff-keep')
  expect((w.store.get(KEY) as Pending).isOutdated).toBeUndefined()
  await cmd($, '')
  await w.clock.settle()
  expect((await band($)).text).toContain('Clearing')
  await w.clock.advance(15_000)
  expect((await band($)).text).toContain('Type | /clear')
  expect(w.commands).toEqual(['clear'])
  await $.session.end({ reason: 'clear', sessionId: 'sess-1234abcd-old', resume: undefined } as never)
  await w.clock.advance(1_000)
  expect(w.modSubmits().length).toBe(1)
  expect((await injected($))[0]?.text).toContain('Ship version two')
})

test('Try clearing again: a second /clear that hangs still turns into the hint after 15 seconds', async ($, on) => {
  let n = 0
  const w = world(on, { commandRun: () => (n++ === 0 ? Promise.resolve({}) : new Promise<never>(() => {})) })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  await w.clock.advance(16_000)
  await press($, w, 'handoff-retry-clear')
  expect((await band($)).text).toContain('Clearing')
  await w.clock.advance(15_000)
  const b = await band($)
  expect(b.text).toContain('Type | /clear')
  expect(b.buttons).toEqual(['handoff-keep'])
})

test('a marker quoted in a code block is text; a slot given twice is joined; an early END is text', async () => {
  const reply = [
    'STATUS: CONTINUE',
    '=== GOAL ===',
    '**Fix the parser**',
    '=== NEXT_STEPS ===',
    '1. x',
    '=== KNOWN_ISSUES ===',
    'Fails on this input:',
    '```',
    '=== GOAL ===',
    'fixture goal',
    '=== END ===',
    '```',
    '- tried X, failed',
    '=== NEXT_STEPS ===',
    '2. y',
    '=== END ===',
  ].join('\n')
  const p = parseHandoff(reply)
  expect(p.slots.GOAL).toBe('**Fix the parser**')
  expect(p.slots.KNOWN_ISSUES).toContain('- tried X, failed')
  expect(p.slots.KNOWN_ISSUES).toContain('fixture goal')
  expect(p.slots.NEXT_STEPS).toBe('1. x\n\n2. y')
  expect(p.isComplete).toBe(true)
  expect(goalLine(p)).toBe('Fix the parser')
  // a whole reply inside one code block still parses
  expect(parseHandoff('```\n=== GOAL ===\ng\n=== NEXT_STEPS ===\nn\n=== END ===\n```').slots.GOAL).toBe('g')
  // STATUS in a body line is not the status
  expect(parseHandoff('=== GOAL ===\ng\nSTATUS: CONTINUE\n=== NEXT_STEPS ===\nn\n=== END ===').status).toBe('WAIT')
})

test('a rejected or failed edit is not listed as edited', async () => {
  const msgs = [{ role: 'assistant', text: 'x', toolUses: [{ tool_use_id: 'a', tool: 'Write', input: { file_path: 'C:\\p\\config.json' }, isError: true }, { tool_use_id: 'b', tool: 'Edit', input: { file_path: 'C:\\p\\ok.ts' } }] }]
  expect(editedFiles(msgs)).toEqual(['C:\\p\\ok.ts'])
})

test('a built-in command is not the latest request; a skill given a task is, and it keeps the conversation', async ($, on) => {
  const w = world(on, { commandRun: async () => ({}) })
  await start($, w)
  await typed($, 'fix the login bug')
  await typed($, '/model opus')
  await measure($, w, 230_000)
  await cmd($, 'write')
  await w.clock.settle()
  expect(w.forks[0]).toContain('<<<\nfix the login bug\n>>>')
  await press($, w, 'handoff-switch-now')
  await typed($, '/gsd-orchestration build the payments page')
  expect((await band($)).text).toContain('cancelled')
})

test('the fallback prompt in write-only mode does not say the conversation will be cleared', async ($, on) => {
  const w = world(on, { replies: ['error', 'error'] })
  await start($, w)
  await measure($, w, 230_000)
  await cmd($, 'write')
  await w.clock.settle()
  await press($, w, 'handoff-ask-session')
  expect(w.modSubmits()[0]?.text).toContain('It is a checkpoint')
  expect(w.modSubmits()[0]?.text).not.toContain('will then be cleared')
})

test('/handoff at says where the offer really comes when the auto-compact point caps it', async ($, on) => {
  const w = world(on)
  await start($, w)
  await measure($, w, 120_000)
  const reply = String((await cmd($, 'at 2m')).text)
  expect(reply).toContain('2M tokens')
  expect(reply).toContain('in effect: 919K')
})

test('the desktop band isolates its Hebrew parts right to left', async ($, on) => {
  const w = world(on, { surface: 'desktop', seed: { [KEY]: waiting() } })
  await start($, w)
  const b = await band($, 'desktop')
  expect(b.texts.some(t => t.startsWith('\u2067') && t.endsWith('\u2069'))).toBe(true)
})

test('a fresh install speaks English in the desktop app until the person writes Hebrew, then remembers it', async ($, on) => {
  const w = world(on, { surface: 'desktop', isNewInstall: true })
  await start($, w)
  await measure($, w, 230_000)
  expect((await band($, 'desktop')).text).toContain('Continue from this point')
  await typed($, 'תמשיך בבקשה')
  expect((await band($, 'desktop')).text).toContain('אפשר להמשיך מאותה נקודה')
  expect(w.store.get('lastLang')).toBe('he')
  await typed($, 'npm ERR! code ERESOLVE could not resolve dependency tree')
  expect((await band($, 'desktop')).text).toContain('אפשר להמשיך מאותה נקודה')
})

test('another conversation took the handoff while the /clear was refused: Try again stands down instead of clearing', async ($, on) => {
  const w = world(on, { commandRun: async () => ({}) })
  await start($, w)
  await measure($, w, 230_000)
  await press($, w, 'handoff-go')
  const stored = w.store.get(KEY) as Pending
  w.store.set(KEY, { ...stored, state: 'consumed', consumedBy: 'another' })
  await press($, w, 'handoff-retry-clear')
  expect(w.commands).toEqual(['clear'])
  expect((await band($)).text).toContain('already picked up in another conversation')
  expect((w.store.get(KEY) as Pending).state).toBe('consumed')
})

test('a saved handoff another conversation took: Switch now does not clear', async ($, on) => {
  const w = world(on)
  await start($, w)
  await measure($, w, 120_000)
  await cmd($, 'write')
  await w.clock.settle()
  const stored = w.store.get(KEY) as Pending
  w.store.set(KEY, { ...stored, state: 'consumed', consumedBy: 'another' })
  await press($, w, 'handoff-switch-now')
  expect(w.commands).toEqual([])
  expect((await band($)).text).toContain('already picked up in another conversation')
})
