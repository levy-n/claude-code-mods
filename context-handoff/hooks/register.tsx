// Context Handoff: when the context grows heavy, offers to continue from the
// same point in a fresh window.
//
// session.measure: after each main turn, compare the context's tokens with the
//   offer line (200K, or 85% of the auto-compact point if lower; /handoff at).
// ui.render (AbovePrompt): the band, [Continue fresh] [Later], and the states
//   that follow. It is the only feedback the desktop app draws (it shows no
//   toasts or log lines), and it draws whenever the app's window is attached.
// On accept: $.model.fork writes a full handoff over the session's own
//   transcript; it is saved to <project>/.context/HANDOFF.md (the previous one
//   archived) and to $.store; then /clear, issued only while no turn runs. The
//   cleared conversation gets the handoff in its first message's context
//   (prompt.context) and a prompt, sent as the user, that carries on from it.
// A new conversation in the folder is offered a handoff still waiting there.
// /handoff: the same on demand, plus write-only, resume, threshold, on/off,
//   status, language.
//
// Every run holds a token (runSeq); a cancel, a new start, a /clear or a
// /resume takes it away, so a fork that returns late never acts.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.

import type { EngineInterface, Register, RenderElement, ThemeKey, Timer } from 'claude-code'

import {
  COMPACT_STEER,
  DEFAULTS,
  HANDOFF_REL,
  SESSION_WRITE_PREFIX,
  WORDS,
  ageText,
  archivePath,
  buildFile,
  describeAt,
  editedFiles,
  failText,
  forkPrompt,
  goalLine,
  helpText,
  injectedBlock,
  isFinalFailure,
  isHebrewText,
  isNetworkRoot,
  isUsable,
  isolate,
  joinPath,
  rtl,
  lastUserText,
  nextOffer,
  normPath,
  offerLine,
  parseCommand,
  parseHandoff,
  readOwnFile,
  resolveLang,
  resumePrompt,
  sessionWritePrompt,
  settingsFolders,
  stateWord,
  storeKey,
  tokensText,
  urgentLine,
} from './core'
import type { FailCode, Facts, Lang, Mode, Parsed, Pending, Retry, Settings } from './core'

const FORK_TIMEOUT_MS = 4 * 60_000
const CLEAR_WAIT_MS = 15_000
/** How long the session must stay quiet after a turn before a queued start or clear goes. */
const QUIET_MS = 1_500
/** A fresh process that finds its folder's handoff cleared into within this (the app may restart the process on /clear) carries on by itself. */
const SWITCH_TTL_MS = 60_000
/** A handoff left waiting is offered to new conversations in its folder for this long. */
const PICKUP_TTL_MS = 3 * 24 * 3_600_000
const STORE_TTL_MS = 14 * 24 * 3_600_000
/** A switch left 'switching' this long was abandoned, and is offered like a saved handoff. */
const ABANDONED_MS = 10 * 60_000
/** The fallback write gives up after this. */
const SESSION_WRITE_MS = 10 * 60_000
/** Times a switch writes the handoff again because a turn ran meanwhile, before it clears anyway. */
const MAX_REFORKS = 1

/** A stored handoff, with the key it lives under and the turn count when its facts were read. */
type Keyed = Pending & { key: string; turnSeqAtFacts?: number; isInWorktree?: boolean; isFreshPickup?: boolean }

type Phase =
  | { kind: 'idle' }
  | { kind: 'offer'; tokens: number; isUrgent: boolean }
  | { kind: 'writing'; mode: Mode }
  | { kind: 'switching'; entry: Keyed }
  | { kind: 'clear-needed'; entry: Keyed }
  | { kind: 'saved'; entry: Keyed }
  | { kind: 'failed'; code: FailCode; status?: number; mode: Mode }
  | { kind: 'session-writing'; path: string; root: string; since: number; mode: Mode; isInWorktree: boolean }
  | { kind: 'pickup'; entry: Keyed }
  | { kind: 'notice'; parts: 'cancelled' | 'taken' }

let phase: Phase = { kind: 'idle' }
let settings: Settings = DEFAULTS
let lang: Lang = 'en'
/** Hebrew once the person has typed Hebrew; kept in the store so every session starts in it. */
let preferredLang: Lang | null = null
/** The auto-compact point in tokens, and the window it was read for. */
let compactAt = 0
let compactWindow = 0
let lastTokens: number | undefined
/** No offer below this many tokens in this conversation (Later, Cancel, Close). */
let snoozeUntil = 0
let isUrgentShown = false
let isWorking = false
/** Main turns started in this process: a handoff whose facts predate a turn is stale. */
let turnSeq = 0
/** The current run's token: a run acts only while it still holds the latest one. */
let runSeq = 0
/** /clear calls that landed in this process. */
let clearCount = 0
let pendingStart: Mode | null = null
/** The queued start is a re-fork of a switch, not something the person asked for. */
let isReforkPending = false
let reforkCount = 0
let quietTimer: Timer | null = null
/** The switch this conversation is clearing into. */
let switchEntry: Keyed | null = null
let clearWatch: Timer | null = null
/** A /clear this mod issued that has not landed yet. */
let clearPending: Keyed | null = null
/** A /clear of this mod's still on its way after the person chose to stay, and the handoff it was for. */
let withdrawnClear: Keyed | null = null
/** /clear calls that came back without clearing, for this switch. */
let clearRefusals = 0
/** The handoff the next conversation starts from, until its first turn ends. */
let resumeArmed: Keyed | null = null
let isResumeInjected = false
let resumeTurnSeq = 0
/** The fallback write turn, known by its prompt. */
let writeTurnId: string | null = null
let writeDeadline: Timer | null = null
let addedFolders: string[] = []
/** The last text a person typed, seen as it was sent; carried across a switch. */
let lastTypedText: string | null = null
/** A 'written' handoff made in this conversation: outdated once the person keeps working. */
let ownWritten: Keyed | null = null

const isBusy = () => phase.kind === 'writing' || phase.kind === 'switching' || phase.kind === 'session-writing'

function asPending(value: unknown): Pending | undefined {
  const p = value as Pending | undefined
  return p !== undefined && p !== null && typeof p === 'object' && typeof p.path === 'string' && typeof p.text === 'string' && typeof p.createdAt === 'number' ? p : undefined
}

function shortReason(err: unknown): string {
  const text = String((err as { message?: unknown } | undefined)?.message ?? err)
  return text.length > 140 ? `${text.slice(0, 137)}...` : text
}

function stripKey(entry: Keyed): Pending {
  const { key: _key, turnSeqAtFacts: _seq, isInWorktree: _wt, isFreshPickup: _fp, ...rest } = entry
  return rest
}

function snoozeFromNow() {
  snoozeUntil = Math.max(snoozeUntil, (lastTokens ?? 0) + settings.remindEvery)
}

function resetOffers() {
  snoozeUntil = 0
  isUrgentShown = false
  if (phase.kind === 'offer') phase = { kind: 'idle' }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    settings = await loadSettings($)
    preferredLang = (await $.store.get('lastLang')) === 'he' ? 'he' : null
    lang = await currentLang($)
    try {
      await $.command.register({
        name: 'handoff',
        description: 'Continue from this point in a fresh window (or: write, resume, at 300k, off, on, status)',
        argumentHint: '[write | resume | at 300k | off | on | status | help]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`context-handoff: /handoff could not be registered (${shortReason(err)})`)
    }
    await pruneStore($)
    // Not awaited: a resume submits a prompt, and no turn starts before session.start returns.
    $.clock.after(0, () => {
      void checkWaiting($)
    })
    return next(e)
  })

  // The desktop app attaches as a surface when its window shows the session: draw what is waiting.
  on('session.attach', async ($, e, next) => {
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const echoed = await next(e)
    const tokens = e.context.tokens
    if (!e.changed.includes('context') || tokens === undefined) return echoed
    settings = await loadSettings($)
    // A compaction this mod did not see: start the offers over.
    if (lastTokens !== undefined && tokens < lastTokens / 2) resetOffers()
    lastTokens = tokens
    if (compactAt === 0 || e.context.window !== compactWindow) await refreshCompact($, e.context.window)
    updateOffer(tokens)
    $.ui.invalidate('ui.render')
    return echoed
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    turnSeq += 1
    quietTimer?.cancel()
    quietTimer = null
    if (phase.kind === 'session-writing' && writeTurnId === null && e.text.includes(SESSION_WRITE_PREFIX)) writeTurnId = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    isWorking = false
    if (resumeArmed !== null && turnSeq > resumeTurnSeq) resumeArmed = null
    if (phase.kind === 'session-writing') {
      const isWriteTurn = writeTurnId !== null && e.turnId === writeTurnId
      const isWrittenAnyway = writeTurnId === null && (await isWrittenSince($, phase.path, phase.since))
      if (isWriteTurn || isWrittenAnyway) {
        writeTurnId = null
        await finishSessionWrite($, e.reason === 'answer' ? phase.mode : 'write')
      }
    }
    whenQuiet($)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const origin = (e as { origin?: { kind?: string } }).origin
    const isPerson = origin === undefined || origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
    const text = e.text.trim()
    const isSlash = text.startsWith('/')
    const name = isSlash ? (text.slice(1).split(/\s+/)[0] ?? '') : ''
    // Work the person asked for: typed text, or a command that is neither built in nor this mod's (a skill).
    const isWork = isPerson && (!isSlash || (name !== 'handoff' && !(await isBuiltinCommand($, name))))
    const isRequest = isWork && (!isSlash || /^\/\S+\s+\S/.test(text))
    const isTyped = isWork
    if (isPerson && !isSlash && preferredLang !== 'he' && isHebrewText(text)) {
      preferredLang = 'he'
      await $.store.set('lastLang', 'he')
      $.ui.invalidate('ui.render')
    }
    if (isTyped) await onPersonTyped($)
    const result = await next(e)
    if (isRequest && !(result as { drop?: unknown }).drop) lastTypedText = text
    return result
  })

  // The cleared conversation's first message carries the handoff.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const entry = resumeArmed
    if (entry === null || isResumeInjected) return result
    isResumeInjected = true
    return { ...result, blocks: [...result.blocks, { name: 'handoff', text: injectedBlock(entry) }] }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') onCleared($)
    else if (e.reason === 'resume') onResumedElsewhere($)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const isSteer = isMain && e.trigger === 'auto' && settings.enabled && !(e.instructions ?? '').includes('[context-handoff]')
    const result = await next(isSteer ? { ...e, instructions: e.instructions ? `${e.instructions}\n\n${COMPACT_STEER}` : COMPACT_STEER } : e)
    if (isMain && e.trigger !== 'precompute' && !(result as { skip?: unknown }).skip) {
      resetOffers()
      lastTokens = undefined
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('classic.DirectoryAdded', async ($, e, next) => {
    const dir = (e as { directory?: unknown }).directory
    if (typeof dir === 'string' && !addedFolders.some(d => normPath(d).toLowerCase() === normPath(dir).toLowerCase())) {
      addedFolders = [...addedFolders, dir]
    }
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    settings = await loadSettings($)
    lang = await currentLang($)
    const he = lang === 'he'
    const action = parseCommand(e.args ?? '')
    switch (action.kind) {
      case 'start': {
        if (isBusy()) return { text: he ? 'העברה כבר רצה, אפשר לעקוב בשורה שמעל תיבת הקלט.' : 'A handoff is already running; see the band above the prompt.' }
        if ((await $.session.turns()) === 0) {
          return { text: phase.kind === 'pickup'
            ? he ? 'בשיחה החדשה הזאת עוד אין מה להעביר. כדי להמשיך מהסיכום שמחכה, לחץ על המשך ממנו בשורה שמעל תיבת הקלט.' : 'Nothing to hand off in this new conversation yet. To continue from the waiting handoff, press Continue from it above the prompt.'
            : he ? 'עוד אין מה להעביר: בשיחה הזאת עוד אין תשובות.' : 'Nothing to hand off yet: this conversation has no replies.' }
        }
        if (isWorking) {
          pendingStart = action.mode
          return { text: he ? 'אתחיל ברגע שקלוד יסיים את התור הנוכחי.' : 'Starting as soon as Claude finishes the current turn.' }
        }
        void startHandoff($, action.mode)
        return { text: action.mode === 'write' ? (he ? 'כותב סיכום לקובץ, והשיחה נשארת פתוחה.' : "Writing the handoff to the project's .context/HANDOFF.md; this conversation stays open.") : (he ? 'כותב סיכום העברה מלא, ואז עובר לחלון נקי.' : 'Writing a full handoff, then switching to a fresh window.') }
      }
      case 'resume': {
        const key = storeKey((await projectRoot($)).root)
        const entry = asPending(await $.store.get(key))
        if (entry === undefined || entry.state === 'consumed' || entry.state === 'dismissed') return { text: he ? 'אין סיכום שמחכה בתיקייה הזאת.' : 'No handoff is waiting in this folder.' }
        void resume($, { ...entry, key }, false, ['written', 'switching'])
        return { text: he ? 'ממשיך מהסיכום.' : 'Continuing from the handoff.' }
      }
      case 'at': {
        if (action.at === undefined) return { text: `${he ? 'ההצעה מגיעה ב' : 'Offers come at'}: ${describeAt(settings.at, lang)}` }
        await saveSettings($, { at: action.at })
        snoozeUntil = 0
        if (phase.kind === 'offer' && !phase.isUrgent && compactAt > 0 && phase.tokens < offerLine(settings.at, compactAt)) phase = { kind: 'idle' }
        else if (phase.kind === 'idle' && lastTokens !== undefined) updateOffer(lastTokens)
        $.ui.invalidate('ui.render')
        const inEffect = compactAt > 0 ? ` (${he ? 'בפועל' : 'in effect'}: ${tokensText(offerLine(settings.at, compactAt), lang)})` : ''
        return { text: `${he ? 'מעכשיו ההצעה תגיע ב' : 'From now on, offers come at'}: ${describeAt(settings.at, lang)}${inEffect}` }
      }
      case 'enable':
        await saveSettings($, { enabled: action.enabled })
        if (!action.enabled && phase.kind === 'offer') phase = { kind: 'idle' }
        else if (action.enabled && lastTokens !== undefined) updateOffer(lastTokens)
        $.ui.invalidate('ui.render')
        return {
          text: action.enabled
            ? he ? 'ההצעות האוטומטיות פעילות.' : 'Automatic offers are on.'
            : he ? 'ההצעות האוטומטיות כבויות. אפשר עדיין לכתוב את הפקודה בכל רגע.' : 'Automatic offers are off. /handoff still works any time.',
        }
      case 'lang':
        await saveSettings($, { language: action.language })
        lang = await currentLang($)
        $.ui.invalidate('ui.render')
        return { text: helpText(lang) }
      case 'status':
        return { text: await statusText($) }
      case 'help':
        return { text: helpText(lang) }
      case 'bad':
        return { text: `${he ? 'לא הבנתי.' : "I didn't understand that."}\n\n${helpText(lang)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || phase.kind === 'idle') return next(e)
    if ((phase.kind === 'offer' || phase.kind === 'pickup') && e.props.isWorking) return next(e)
    const l = resolveLang(settings.language, e.surface, preferredLang)
    const w = WORDS[l]
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const now = await $.clock.now()
    const p = phase
    let parts: string[] = []
    let color: ThemeKey = 'suggestion'
    let detail = ''
    let buttons: RenderElement[] = []
    switch (p.kind) {
      case 'offer':
        parts = p.isUrgent ? w.offerUrgent(p.tokens) : w.offer(p.tokens)
        color = p.isUrgent ? 'warning' : 'suggestion'
        buttons = [
          <Button key="handoff-go" label={w.go} variant="primary" onPress={() => void startHandoff($, 'switch')} />,
          <Button key="handoff-later" label={w.later} onPress={() => later($)} />,
        ]
        break
      case 'writing':
        parts = p.mode === 'switch' ? w.writing : w.writingOnly
        buttons = [<Button key="handoff-cancel" label={w.cancel} onPress={() => cancelWriting($)} />]
        break
      case 'switching':
        parts = isWorking ? w.waitingForTurn : w.switching
        color = 'success'
        break
      case 'clear-needed': {
        const isStuck = clearRefusals >= 2
        parts = isStuck ? w.clearStillNeeded : w.clearNeeded
        color = 'warning'
        buttons = [
          ...(isStuck || clearPending !== null ? [] : [<Button key="handoff-retry-clear" label={w.retryClear} variant="primary" onPress={() => void retryClear($)} />]),
          <Button key="handoff-keep" label={w.keep} onPress={() => void keepForLater($, false)} />,
        ]
        break
      }
      case 'saved':
        parts = w.saved
        color = 'success'
        detail = p.entry.isInWorktree === true ? p.entry.path : HANDOFF_REL
        buttons = [
          <Button key="handoff-switch-now" label={w.switchNow} variant="primary" onPress={() => void requestSwitch($, p.entry)} />,
          <Button key="handoff-close" label={w.close} onPress={() => closeBand($)} />,
        ]
        break
      case 'failed': {
        parts = w.failed(failText(p.code, l, p.status))
        color = 'error'
        const final = isFinalFailure(p.code)
        buttons = [
          ...(final ? [] : [
            <Button key="handoff-retry" label={w.retry} variant="primary" onPress={() => void startHandoff($, p.mode)} />,
            <Button key="handoff-ask-session" label={w.askSession} onPress={() => void askSessionToWrite($, p.mode)} />,
          ]),
          <Button key="handoff-close" label={w.close} onPress={() => closeBand($)} />,
        ]
        break
      }
      case 'session-writing':
        parts = p.mode === 'switch' ? w.sessionWriting : w.writingOnly
        buttons = [
          ...(p.mode === 'switch' ? [<Button key="handoff-stop-switch" label={w.stopSwitch} onPress={() => stopSessionSwitch($)} />] : []),
          <Button key="handoff-cancel-write" label={w.cancel} onPress={() => cancelSessionWrite($)} />,
        ]
        break
      case 'pickup':
        parts = w.pickup(ageText(now - p.entry.createdAt, l), p.entry.isOutdated === true)
        detail = p.entry.goal
        buttons = [
          <Button key="handoff-pickup" label={w.pickupGo} variant="primary" onPress={() => void resume($, p.entry, p.entry.isFreshPickup === true, ['written', 'switching'])} />,
          <Button key="handoff-ignore" label={w.pickupIgnore} onPress={() => void ignoreWaiting($, p.entry)} />,
        ]
        break
      case 'notice':
        parts = p.parts === 'taken' ? w.takenElsewhere : w.cancelledByMessage
        color = 'subtle'
        buttons = [<Button key="handoff-close" label={w.close} onPress={() => closeBand($)} />]
        break
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection={l === 'he' ? 'row-reverse' : 'row'} flexWrap="wrap" gap={1} alignItems="center">
          {parts.map((part, i) => (
            <Text key={`handoff-part-${i}`} color={color}>{l === 'he' && /[\u0590-\u05FF]/.test(part) ? rtl(part) : part}</Text>
          ))}
          {detail !== '' && <Text dimColor>{l === 'he' ? isolate(detail) : detail}</Text>}
          {buttons}
        </Box>
        {below}
      </Box>
    )
  })

}


/** Built-in commands (/model, /compact, /clear...) are not work or requests. */
const KNOWN_BUILTINS = new Set(['clear', 'compact', 'model', 'effort', 'config', 'rename', 'add-dir', 'resume', 'context', 'cost', 'usage', 'help', 'status', 'reload-plugins', 'plugin', 'mcp', 'memory', 'permissions', 'fast', 'autocompact', 'output-style', 'agents', 'doctor', 'init'])

async function isBuiltinCommand($: EngineInterface, name: string): Promise<boolean> {
  try {
    return (await $.command.list()).some(c => c.name === name && c.source === 'builtin')
  } catch {
    return KNOWN_BUILTINS.has(name)
  }
}

// ---------------------------------------------------------------- settings, language, root

async function loadSettings($: EngineInterface): Promise<Settings> {
  const stored = await $.store.get('settings')
  return { ...DEFAULTS, ...(stored !== null && typeof stored === 'object' ? (stored as Partial<Settings>) : {}) }
}

/** Re-read first, so a change made in another session is not undone by this one's old copy. */
async function saveSettings($: EngineInterface, patch: Partial<Settings>) {
  settings = { ...(await loadSettings($)), ...patch }
  await $.store.set('settings', settings)
}

/** The terminal reads English (it has no right-to-left layout); the desktop app, or no surface, Hebrew. */
async function currentLang($: EngineInterface): Promise<Lang> {
  const surfaces: readonly string[] = await $.session.surfaces()
  return resolveLang(settings.language, surfaces.includes('terminal') ? 'terminal' : 'desktop', preferredLang)
}

/** The project the handoff belongs to: the main checkout when the session runs in one of its worktrees. */
async function projectRoot($: EngineInterface): Promise<{ root: string; worktree?: string }> {
  const root: string = await $.session.root()
  const repo = await $.session.repo().catch(() => null)
  if (repo === null || normPath(repo.root).toLowerCase() === normPath(root).toLowerCase()) return { root }
  const git = await $.fs.stat(joinPath(root, '.git')).catch(() => undefined)
  return git !== undefined && git.kind === 'file' ? { root: repo.root, worktree: root } : { root }
}

async function refreshCompact($: EngineInterface, window: number) {
  compactWindow = window
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const b = (usage.context as { breakdown?: { autoCompactThreshold?: number; isAutoCompactEnabled?: boolean; rawMaxTokens?: number } }).breakdown
    const point = b?.isAutoCompactEnabled === false ? undefined : b?.autoCompactThreshold
    compactAt = point ?? b?.rawMaxTokens ?? window
  } catch {
    compactAt = window
  }
  if (!(compactAt > 0)) compactAt = 200_000
}

// ---------------------------------------------------------------- offers

function updateOffer(tokens: number) {
  if (compactAt === 0 || pendingStart !== null) return
  const urgent = urgentLine(compactAt)
  if (phase.kind === 'offer') {
    const isDue = settings.enabled && (phase.isUrgent ? tokens >= urgent : tokens >= offerLine(settings.at, compactAt))
    if (!isDue) phase = { kind: 'idle' }
    else if (!phase.isUrgent && tokens >= urgent && !isUrgentShown) {
      isUrgentShown = true
      phase = { kind: 'offer', tokens, isUrgent: true }
    } else phase = { ...phase, tokens }
    return
  }
  if (phase.kind !== 'idle' || !settings.enabled) return
  const isUrgent = tokens >= urgent
  if (isUrgent ? isUrgentShown : tokens < nextOffer(settings.at, compactAt, snoozeUntil)) return
  if (isUrgent) isUrgentShown = true
  phase = { kind: 'offer', tokens, isUrgent }
}

function later($: EngineInterface) {
  snoozeFromNow()
  phase = { kind: 'idle' }
  $.ui.invalidate('ui.render')
}

function closeBand($: EngineInterface) {
  if (phase.kind === 'saved' || phase.kind === 'failed') snoozeFromNow()
  phase = { kind: 'idle' }
  $.ui.invalidate('ui.render')
}

function cancelWriting($: EngineInterface) {
  runSeq += 1
  snoozeFromNow()
  phase = { kind: 'idle' }
  $.ui.invalidate('ui.render')
}

/** A person typed a message (not a command): whatever was about to take the conversation away stands down. */
async function onPersonTyped($: EngineInterface) {
  if (isReforkPending) {
    pendingStart = null
    isReforkPending = false
    phase = { kind: 'notice', parts: 'cancelled' }
  } else if (phase.kind === 'writing' && phase.mode === 'switch') {
    runSeq += 1
    snoozeFromNow()
    phase = { kind: 'notice', parts: 'cancelled' }
  } else if (phase.kind === 'session-writing' && phase.mode === 'switch') {
    phase = { ...phase, mode: 'write' }
  } else if (phase.kind === 'switching' || phase.kind === 'clear-needed') {
    await keepForLater($)
    phase = { kind: 'notice', parts: 'cancelled' }
  } else if (phase.kind === 'saved' || phase.kind === 'failed') {
    snoozeFromNow()
    phase = { kind: 'idle' }
  } else if (phase.kind === 'pickup' || phase.kind === 'notice') {
    phase = { kind: 'idle' }
  }
  if (ownWritten !== null) {
    const entry = ownWritten
    ownWritten = null
    const cur = asPending(await $.store.get(entry.key))
    if (cur !== undefined && cur.createdAt === entry.createdAt && cur.state === 'written') await $.store.set(entry.key, { ...cur, isOutdated: true })
  }
  $.ui.invalidate('ui.render')
}

/** After a main turn, once the session stays quiet: a queued start, or a clear waiting for idle. */
function whenQuiet($: EngineInterface) {
  if (pendingStart === null && !(phase.kind === 'switching' && switchEntry !== null)) return
  quietTimer?.cancel()
  quietTimer = $.clock.after(QUIET_MS, () => {
    quietTimer = null
    if (isWorking) return
    if (pendingStart !== null && !isBusy()) {
      const mode = pendingStart
      const origin = isReforkPending ? 'refork' : 'person'
      pendingStart = null
      isReforkPending = false
      void startHandoff($, mode, origin)
    } else if (phase.kind === 'switching' && switchEntry !== null) {
      issueClear($)
    }
  })
}

// ---------------------------------------------------------------- writing the handoff

async function collectFacts($: EngineInterface): Promise<Facts> {
  const now: number = await $.clock.now()
  const sessionId: string = await $.session.id()
  const cwd: string = await $.session.cwd()
  const { root, worktree } = await projectRoot($)
  const path = joinPath(root, HANDOFF_REL)
  const usage = await $.session.usage()
  const tokens: number | undefined = usage.context.tokens ?? lastTokens
  if (compactAt === 0) await refreshCompact($, usage.context.window)
  const merged = await $.settings.read().catch(() => undefined)
  const found = await $.session.messages()
  const messages = Array.isArray(found) ? found : []
  let previous: string | undefined
  let previousMtime: number | undefined
  if (!isNetworkRoot(root) && (await $.fs.exists(path))) {
    const text = await $.fs.read(path)
    previous = typeof text === 'string' ? text : undefined
    previousMtime = (await $.fs.stat(path).catch(() => undefined))?.mtimeMs
  }
  return {
    now,
    sessionId,
    tokens,
    compactAt,
    cwd,
    root,
    worktree,
    path,
    folders: settingsFolders(merged),
    addedFolders,
    editedFiles: editedFiles(messages),
    lastUserText: lastTypedText ?? lastUserText(messages),
    isLastUserTextSeen: lastTypedText !== null,
    previous,
    previousMtime,
  }
}

type ForkOutcome = { isOk: true; text: string } | { isOk: false; code: FailCode; status?: number }

async function forkOnce($: EngineInterface, prompt: string): Promise<ForkOutcome> {
  let timer: Timer | undefined
  const timeout = new Promise<ForkOutcome>(resolve => {
    timer = $.clock.after(FORK_TIMEOUT_MS, () => resolve({ isOk: false, code: 'timeout' }))
  })
  const answer: Promise<ForkOutcome> = $.model.fork({ prompt }).then(
    (r): ForkOutcome => {
      const got = r as { isAnswered?: boolean; text?: unknown; reason?: string; status?: number | null } | null | undefined
      if (got === null || got === undefined) return { isOk: false, code: 'no-answer' }
      if (got.isAnswered === true && typeof got.text === 'string') return { isOk: true, text: got.text }
      if (got.reason === 'api-error') return { isOk: false, code: 'api-error', status: got.status ?? undefined }
      if (got.reason === 'nothing-to-fork' || got.reason === 'empty-reply' || got.reason === 'aborted') return { isOk: false, code: got.reason }
      return { isOk: false, code: 'no-answer' }
    },
    (): ForkOutcome => ({ isOk: false, code: 'error' }),
  )
  const outcome = await Promise.race([answer, timeout])
  timer?.cancel()
  return outcome
}

async function startHandoff($: EngineInterface, mode: Mode, origin: 'person' | 'refork' = 'person') {
  if (isBusy()) return
  if (origin === 'person') reforkCount = 0
  // A switch still waiting for /clear gives way to the new run.
  if (switchEntry !== null) {
    const old = switchEntry
    switchEntry = null
    if (clearPending !== null) {
      withdrawnClear = clearPending
      clearPending = null
    }
    clearWatch?.cancel()
    clearWatch = null
    await keepEntryWritten($, old, true)
  }
  const run = ++runSeq
  const isStale = () => run !== runSeq
  // A turn still running is not in the transcript the fork sees.
  const seqAtFacts = isWorking ? turnSeq - 1 : turnSeq
  const clearsAtStart = clearCount
  phase = { kind: 'writing', mode }
  $.ui.invalidate('ui.render')
  try {
    const facts = await collectFacts($)
    if (isStale()) return
    if (isNetworkRoot(facts.root)) return fail($, 'network-folder', mode)
    let best: Parsed | undefined
    let code: FailCode = 'no-answer'
    let status: number | undefined
    let retry: Retry = 'none'
    for (let attempt = 0; attempt < 2; attempt++) {
      const got = await forkOnce($, forkPrompt(facts, retry, mode))
      if (isStale()) return
      if (!got.isOk) {
        code = got.code
        status = got.status
        if (got.code === 'nothing-to-fork') break
        retry = got.code === 'timeout' ? 'tighter' : 'none'
        if (got.code === 'api-error' && (got.status === 429 || got.status === 529)) await $.clock.sleep(5_000)
        if (isStale()) return
        continue
      }
      const parsed = parseHandoff(got.text)
      if (!isUsable(parsed)) {
        code = 'bad-format'
        retry = 'format'
        continue
      }
      if (best === undefined || parsed.isComplete) best = parsed
      if (parsed.isComplete) break
      code = 'cut-short'
      retry = 'tighter'
    }
    if (best === undefined) return fail($, code, mode, status)
    const text = buildFile(best, facts)
    await saveFile($, facts.path, facts.root, text, facts.now)
    if (isStale()) return
    // A /clear came while it was being written: keep it, and offer it in the new conversation.
    const isAcrossClear = clearCount !== clearsAtStart
    const entry: Keyed = {
      key: storeKey(facts.root),
      path: facts.path,
      text,
      goal: goalLine(best),
      status: best.status,
      tokens: facts.tokens,
      fromSession: facts.sessionId,
      createdAt: facts.now,
      state: mode === 'switch' && !isAcrossClear ? 'switching' : 'written',
      lastTypedText: lastTypedText ?? undefined,
      turnSeqAtFacts: seqAtFacts,
      isInWorktree: facts.worktree !== undefined,
    }
    if (isAcrossClear) {
      await $.store.set(entry.key, stripKey(entry))
      if (isStale()) return
      phase = { kind: 'pickup', entry }
      $.ui.invalidate('ui.render')
      return
    }
    await afterWritten($, entry, mode, isStale)
  } catch (err) {
    if (isStale()) return
    $.ui.log(`context-handoff: ${shortReason(err)}`, { to: 'debug' })
    fail($, 'error', mode)
  }
}

function fail($: EngineInterface, code: FailCode, mode: Mode, status?: number) {
  phase = { kind: 'failed', code, status, mode }
  $.ui.invalidate('ui.render')
}

async function saveFile($: EngineInterface, path: string, root: string, text: string, now: number) {
  if (await $.fs.exists(path)) {
    const old = await $.fs.read(path)
    if (typeof old === 'string' && old.trim() !== '' && old !== text) await $.fs.write(archivePath(root, now), old)
  }
  await $.fs.write(path, text)
}

async function afterWritten($: EngineInterface, entry: Keyed, mode: Mode, isStale: () => boolean) {
  await $.store.set(entry.key, stripKey(entry))
  if (isStale()) return
  if (mode === 'write') {
    ownWritten = entry
    phase = { kind: 'saved', entry }
    $.ui.invalidate('ui.render')
    return
  }
  await requestSwitch($, entry)
}

// ---------------------------------------------------------------- switching

/** Clear into the handoff: at once when idle, otherwise when the running turn is over. */
async function requestSwitch($: EngineInterface, entry: Keyed) {
  const stored = asPending(await $.store.get(entry.key))
  if (stored !== undefined && stored.createdAt === entry.createdAt && (stored.state === 'consumed' || stored.state === 'dismissed')) {
    standDown($, entry, stored)
    return
  }
  const switchingAt: number = await $.clock.now()
  const moving: Keyed = { ...entry, state: 'switching', switchingAt }
  ownWritten = null
  switchEntry = moving
  phase = { kind: 'switching', entry: moving }
  $.ui.invalidate('ui.render')
  await $.store.set(moving.key, stripKey(moving))
  if (isWorking) return // whenQuiet issues it after the turn
  issueClear($)
}

/** The handoff this switch was for is gone or taken: stop, and say so if another conversation took it. */
function standDown($: EngineInterface, entry: Keyed, cur: Pending | undefined) {
  if (clearPending === entry) clearPending = null
  if (switchEntry === entry) switchEntry = null
  clearWatch?.cancel()
  clearWatch = null
  phase = cur !== undefined && cur.createdAt === entry.createdAt && cur.state === 'consumed' ? { kind: 'notice', parts: 'taken' } : { kind: 'idle' }
  $.ui.invalidate('ui.render')
}

/** Facts read before a turn that has run since: the handoff misses that turn. */
const isStaleEntry = (entry: Keyed) => entry.turnSeqAtFacts !== undefined && entry.turnSeqAtFacts !== turnSeq

/** The /clear itself. A handoff whose facts predate a turn is written again first. */
function issueClear($: EngineInterface) {
  const entry = switchEntry
  if (entry === null || clearPending !== null) return
  if (isStaleEntry(entry) && reforkCount < MAX_REFORKS) {
    reforkCount += 1
    switchEntry = null
    phase = { kind: 'idle' }
    void keepEntryWritten($, entry, true)
    pendingStart = 'switch'
    isReforkPending = true
    whenQuiet($)
    return
  }
  clearWatch?.cancel()
  clearWatch = $.clock.after(CLEAR_WAIT_MS, () => {
    clearWatch = null
    if (phase.kind !== 'switching' || isWorking) return
    phase = { kind: 'clear-needed', entry }
    $.ui.invalidate('ui.render')
  })
  // A /clear still on its way from a switch the person set aside serves this one: no second /clear.
  if (withdrawnClear !== null) {
    clearPending = entry
    withdrawnClear = null
    return
  }
  $.clock.after(0, () => {
    void runClear($, entry)
  })
}

async function runClear($: EngineInterface, entry: Keyed) {
  if (clearPending !== null || switchEntry !== entry) return
  clearPending = entry
  const before = clearCount
  const cur = asPending(await $.store.get(entry.key))
  if (cur === undefined || cur.createdAt !== entry.createdAt || cur.state !== 'switching') {
    standDown($, entry, cur)
    return
  }
  await $.store.set(entry.key, { ...cur, clearIssuedAt: await $.clock.now() })
  try {
    await $.command.run({ command: 'clear' })
  } catch {
    // refused or unknown here: the check below tells
  }
  if (clearCount !== before) return
  if (clearPending === entry) clearPending = null
  if (withdrawnClear === entry) withdrawnClear = null
  clearRefusals += 1
  if (phase.kind === 'switching' && !isWorking) {
    phase = { kind: 'clear-needed', entry: phase.entry }
    $.ui.invalidate('ui.render')
  }
}

async function retryClear($: EngineInterface) {
  if (phase.kind !== 'clear-needed' || isWorking || clearPending !== null) return
  phase = { kind: 'switching', entry: phase.entry }
  $.ui.invalidate('ui.render')
  issueClear($)
}

/**
 * The person chose to stay: the handoff waits for a later conversation. Typed on
 * (isOutdated), it is older than the conversation from the start; kept by the
 * button, it becomes outdated only once the person types.
 */
async function keepForLater($: EngineInterface, isOutdated = true) {
  const entry = switchEntry
  switchEntry = null
  if (isReforkPending) {
    pendingStart = null
    isReforkPending = false
  }
  if (clearPending !== null) {
    withdrawnClear = clearPending
    clearPending = null
  }
  clearWatch?.cancel()
  clearWatch = null
  phase = { kind: 'idle' }
  snoozeFromNow()
  $.ui.invalidate('ui.render')
  if (entry === null) return
  await keepEntryWritten($, entry, isOutdated)
  if (!isOutdated) ownWritten = entry
}

function onCleared($: EngineInterface) {
  const entry = (phase.kind === 'switching' || phase.kind === 'clear-needed') ? switchEntry : null
  // A /clear of this mod's that landed after the person chose to stay: the conversation is gone anyway, so pick up, carefully.
  const withdrawn = entry === null ? withdrawnClear : null
  const isFresh = entry !== null && !isStaleEntry(entry)
  const saved = phase.kind === 'saved' ? phase.entry : null
  const isWritingAcross = phase.kind === 'writing'
  if (!isWritingAcross) runSeq += 1
  clearCount += 1
  reforkCount = 0
  isReforkPending = false
  writeDeadline?.cancel()
  writeDeadline = null
  clearPending = null
  withdrawnClear = null
  clearRefusals = 0
  clearWatch?.cancel()
  clearWatch = null
  quietTimer?.cancel()
  quietTimer = null
  lastTokens = undefined
  snoozeUntil = 0
  isUrgentShown = false
  isWorking = false
  pendingStart = null
  writeTurnId = null
  resumeArmed = null
  isResumeInjected = false
  ownWritten = null
  lastTypedText = null
  switchEntry = null
  phase = isWritingAcross ? { kind: 'writing', mode: 'write' } : saved !== null ? { kind: 'pickup', entry: saved } : { kind: 'idle' }
  const next = entry ?? withdrawn
  if (next !== null) {
    $.clock.after(1000, () => {
      void resume($, next, isFresh, entry !== null ? ['switching'] : ['written', 'switching'])
    })
  } else if (saved === null && !isWritingAcross) {
    $.clock.after(1000, () => {
      void checkWaiting($)
    })
  }
  $.ui.invalidate('ui.render')
}

/** /resume or /branch: another conversation now; nothing of this one carries over. */
function onResumedElsewhere($: EngineInterface) {
  runSeq += 1
  reforkCount = 0
  isReforkPending = false
  writeDeadline?.cancel()
  writeDeadline = null
  clearPending = null
  withdrawnClear = null
  clearRefusals = 0
  clearWatch?.cancel()
  clearWatch = null
  quietTimer?.cancel()
  quietTimer = null
  const entry = switchEntry
  switchEntry = null
  lastTokens = undefined
  snoozeUntil = 0
  isUrgentShown = false
  pendingStart = null
  writeTurnId = null
  resumeArmed = null
  isResumeInjected = false
  ownWritten = null
  lastTypedText = null
  phase = { kind: 'idle' }
  if (entry !== null) void keepEntryWritten($, entry)
  $.ui.invalidate('ui.render')
}

async function keepEntryWritten($: EngineInterface, entry: Keyed, isOutdated = false) {
  const cur = asPending(await $.store.get(entry.key))
  if (cur !== undefined && cur.createdAt === entry.createdAt && cur.state === 'switching') await $.store.set(entry.key, { ...cur, state: 'written', ...(isOutdated ? { isOutdated: true } : {}) })
}

// ---------------------------------------------------------------- the next conversation

/** Take the entry for this conversation, if it is still what we think it is; another session can't take it twice. */
async function claim($: EngineInterface, entry: Keyed, from: readonly Pending['state'][]): Promise<Pending | undefined> {
  const cur = asPending(await $.store.get(entry.key))
  if (cur === undefined || cur.createdAt !== entry.createdAt || !from.includes(cur.state)) return undefined
  await $.store.set(entry.key, { ...cur, state: 'consumed', consumedBy: await $.session.id() })
  return cur
}

async function resume($: EngineInterface, entry: Keyed, isFresh: boolean, from: readonly Pending['state'][]) {
  const claimed = await claim($, entry, from)
  if (claimed === undefined) {
    const cur = asPending(await $.store.get(entry.key))
    const isTakenElsewhere = cur !== undefined && cur.createdAt === entry.createdAt && cur.state === 'consumed'
    phase = isTakenElsewhere ? { kind: 'notice', parts: 'taken' } : { kind: 'idle' }
    $.ui.invalidate('ui.render')
    return
  }
  // The file wins over the stored copy: the person may have edited it.
  let current: Keyed = { ...claimed, key: entry.key }
  try {
    const onDisk = (await $.fs.exists(entry.path)) ? await $.fs.read(entry.path) : undefined
    if (typeof onDisk === 'string' && onDisk.trim() !== '' && onDisk !== claimed.text) {
      const own = readOwnFile(onDisk)
      current = { ...current, text: onDisk, goal: own.goal !== 'continue the work' ? own.goal : current.goal, status: own.hasStatus ? own.status : current.status }
    }
  } catch {
    // keep the stored copy
  }
  phase = { kind: 'idle' }
  resumeArmed = current
  isResumeInjected = false
  $.ui.invalidate('prompt.context')
  resumeTurnSeq = turnSeq
  if (current.lastTypedText !== undefined) lastTypedText = current.lastTypedText
  lang = await currentLang($)
  $.ui.invalidate('ui.render')
  try {
    const sent = await $.prompt.submit({ text: resumePrompt(current, lang, isFresh), asUser: true })
    if ((sent as { drop?: unknown } | undefined)?.drop) throw new Error(String((sent as { drop?: unknown }).drop))
  } catch {
    resumeArmed = null
    await $.store.set(entry.key, { ...stripKey(current), state: 'written' })
    phase = { kind: 'pickup', entry: current }
    $.ui.invalidate('ui.render')
  }
}

/** A fresh conversation (a new process, or a /clear not of this mod's making) in a folder with a handoff waiting. */
async function checkWaiting($: EngineInterface) {
  if ((await $.session.turns()) > 0 || phase.kind !== 'idle') return
  const { root } = await projectRoot($)
  const key = storeKey(root)
  const entry = asPending(await $.store.get(key))
  if (entry === undefined) return
  const now: number = await $.clock.now()
  // Just cleared into: most likely this conversation, if the app restarted on /clear; still offered, never taken unasked.
  const isJustCleared = entry.state === 'switching' && entry.clearIssuedAt !== undefined && now - entry.clearIssuedAt < SWITCH_TTL_MS
  const isAbandoned = entry.state === 'switching' && now - (entry.switchingAt ?? entry.createdAt) > ABANDONED_MS
  if ((entry.state === 'written' || isJustCleared || isAbandoned) && now - entry.createdAt < PICKUP_TTL_MS) {
    phase = { kind: 'pickup', entry: { ...entry, key, isFreshPickup: isJustCleared } }
    $.ui.invalidate('ui.render')
  }
}

async function ignoreWaiting($: EngineInterface, entry: Keyed) {
  phase = { kind: 'idle' }
  $.ui.invalidate('ui.render')
  const cur = asPending(await $.store.get(entry.key))
  if (cur !== undefined && cur.createdAt === entry.createdAt && cur.state !== 'consumed') await $.store.set(entry.key, { ...cur, state: 'dismissed' })
}

/** Old entries go; settings stay. */
async function pruneStore($: EngineInterface) {
  const now: number = await $.clock.now()
  const keys: string[] = await $.store.keys()
  for (const key of keys) {
    if (!key.startsWith('pending:')) continue
    const entry = asPending(await $.store.get(key))
    if (entry === undefined || now - entry.createdAt > STORE_TTL_MS) await $.store.delete(key)
  }
}

// ---------------------------------------------------------------- the fallback: the session writes it

async function askSessionToWrite($: EngineInterface, mode: Mode) {
  if (isBusy()) return
  runSeq += 1
  const now: number = await $.clock.now()
  const { root, worktree } = await projectRoot($)
  const path = joinPath(root, HANDOFF_REL)
  try {
    if (await $.fs.exists(path)) {
      const old = await $.fs.read(path)
      if (typeof old === 'string' && old.trim() !== '') await $.fs.write(archivePath(root, now), old)
    }
    writeTurnId = null
    phase = { kind: 'session-writing', path, root, since: now, mode, isInWorktree: worktree !== undefined }
    $.ui.invalidate('ui.render')
    writeDeadline?.cancel()
    writeDeadline = $.clock.after(SESSION_WRITE_MS, () => {
      writeDeadline = null
      if (phase.kind === 'session-writing') fail($, 'not-written', phase.mode)
    })
    const sent = await $.prompt.submit({ text: sessionWritePrompt(path, mode), asUser: true })
    if ((sent as { drop?: unknown } | undefined)?.drop) fail($, 'not-written', mode)
  } catch {
    fail($, 'error', mode)
  }
}

function stopSessionSwitch($: EngineInterface) {
  if (phase.kind !== 'session-writing') return
  phase = { ...phase, mode: 'write' }
  $.ui.invalidate('ui.render')
}

function cancelSessionWrite($: EngineInterface) {
  if (phase.kind !== 'session-writing') return
  writeTurnId = null
  writeDeadline?.cancel()
  writeDeadline = null
  snoozeFromNow()
  phase = { kind: 'idle' }
  $.ui.invalidate('ui.render')
}

async function isWrittenSince($: EngineInterface, path: string, since: number): Promise<boolean> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  return stat !== undefined && stat.mtimeMs >= since - 2000
}

async function finishSessionWrite($: EngineInterface, mode: Mode) {
  if (phase.kind !== 'session-writing') return
  writeDeadline?.cancel()
  writeDeadline = null
  const { path, root, since, isInWorktree } = phase
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.mtimeMs < since - 2000) return fail($, 'not-written', mode)
  const text = await $.fs.read(path)
  if (typeof text !== 'string' || text.trim() === '') return fail($, 'empty-file', mode)
  const own = readOwnFile(text)
  const run = ++runSeq
  await afterWritten($, {
    key: storeKey(root),
    path,
    text,
    goal: own.goal,
    status: own.status,
    tokens: lastTokens,
    fromSession: await $.session.id(),
    createdAt: await $.clock.now(),
    state: mode === 'switch' ? 'switching' : 'written',
    lastTypedText: lastTypedText ?? undefined,
    turnSeqAtFacts: turnSeq,
    isInWorktree,
  }, mode, () => run !== runSeq)
}

// ---------------------------------------------------------------- /handoff status

async function statusText($: EngineInterface): Promise<string> {
  const he = lang === 'he'
  const usage = await $.session.usage()
  const tokens: number | undefined = usage.context.tokens ?? lastTokens
  if (compactAt === 0) await refreshCompact($, usage.context.window)
  const { root } = await projectRoot($)
  const path = joinPath(root, HANDOFF_REL)
  const waiting = asPending(await $.store.get(storeKey(root)))
  const line = offerLine(settings.at, compactAt)
  const next = nextOffer(settings.at, compactAt, snoozeUntil)
  const t = (n: number) => tokensText(n, lang)
  const exists = !isNetworkRoot(root) && (await $.fs.exists(path))
  const rows = he
    ? [
        `הקשר: ${tokens === undefined ? 'עוד אין מדידה' : `${t(tokens)} טוקנים`} · דחיסה אוטומטית בערך ב-${t(compactAt)}`,
        `הצעה אוטומטית: ${settings.enabled ? describeAt(settings.at, 'he') : 'כבויה'} · כרגע ב-${t(line)}${next > line ? ` · נדחתה עד ${t(next)}` : ''}`,
        `קובץ הסיכום${exists ? '' : ' (עוד לא קיים)'}: ${isolate(path)}`,
        waiting === undefined ? 'אין סיכום שמחכה' : `סיכום אחרון: ${stateWord(waiting.state, 'he')} · ${isolate(waiting.goal)}`,
      ]
    : [
        `Context: ${tokens === undefined ? 'not measured yet' : `${t(tokens)} tokens`} · auto-compact at about ${t(compactAt)}`,
        `Automatic offer: ${settings.enabled ? describeAt(settings.at, 'en') : 'off'} (now at ${t(line)}${next > line ? `, snoozed until ${t(next)}` : ''})`,
        `Handoff file: ${path}${exists ? '' : ' (not written yet)'}`,
        waiting === undefined ? 'No handoff waiting' : `Last handoff: ${waiting.goal} · ${stateWord(waiting.state, 'en')}`,
      ]
  return rows.join('\n')
}
