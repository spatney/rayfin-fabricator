/**
 * What Ray says.
 *
 * His words are in the `mascot` catalogs: the English in
 * src/renderer/src/i18n/locales/en/mascot.json, each translation beside it.
 * This file holds their keys, picks what he says, and translates it when he
 * says it. Rayfin facts (`facts.rayfin`) are checked against the Rayfin docs
 * (rayfin.ai, v1.36), tips (`facts.tip`) against Fabricator itself, and ray
 * facts (`facts.ray`) against marine-biology sources — keep them true, in every
 * language, when any of those change. Lines stay short: he's a stingray in a
 * speech bubble, not a manual.
 */

import { translator } from '../../i18n'
import type { StartupStage } from '../../startup'
import type { DeployTopic } from '../../deployProgress'

export type LineKind = 'rayfin' | 'tip' | 'ray' | 'quip' | 'chat'

export interface MascotLine {
  kind: LineKind
  text: string
}

/** A line's key in the `mascot` catalogs, from the lists below. */
type Key =
  | (typeof RAYFIN_FACTS)[number]
  | (typeof FABRICATOR_TIPS)[number]
  | (typeof RAY_FACTS)[number]
  | (typeof QUIPS)[number]
  | (typeof CHAT)[keyof typeof CHAT]
  | (typeof PLAY)[Play][number]
  | (typeof WORKING)[number]
  | (typeof SPLASH)[StartupStage][number]
  | (typeof TROUBLE)[DeployTrouble]
  | (typeof DEPLOY)[DeployTopic][number]

/** A line in the language shown now. */
function text(key: Key): string {
  return translator('mascot')(key)
}

/**
 * Lines that read in the language shown whenever they're read: a list other
 * screens index into and search, as they did when it held English.
 */
function liveList(keys: readonly Key[]): readonly string[] {
  const list: string[] = []
  keys.forEach((key, i) =>
    Object.defineProperty(list, i, { get: () => text(key), enumerable: true })
  )
  return list
}

function liveLists<K extends string>(
  lists: Record<K, readonly Key[]>
): Record<K, readonly string[]> {
  const out = {} as Record<K, readonly string[]>
  for (const name of Object.keys(lists) as K[]) out[name] = liveList(lists[name])
  return out
}

/** Like `liveList`, for one line by name. */
function liveRecord<K extends string>(keys: Record<K, Key>): Record<K, string> {
  const out = {} as Record<K, string>
  for (const name of Object.keys(keys) as K[]) {
    Object.defineProperty(out, name, { get: () => text(keys[name]), enumerable: true })
  }
  return out
}

/** The small label above a line, when it has one. */
export function lineLabel(kind: LineKind): string | null {
  const t = translator('mascot')
  switch (kind) {
    case 'rayfin':
      return t('labels.rayfin')
    case 'tip':
      return t('labels.tip')
    case 'ray':
      return t('labels.ray')
    default:
      return null
  }
}

export const RAYFIN_FACTS = [
  'facts.rayfin.classes',
  'facts.rayfin.decorators',
  'facts.rayfin.rayfinUp',
  'facts.rayfin.boundary',
  'facts.rayfin.signIn',
  'facts.rayfin.rowLevelSecurity',
  'facts.rayfin.relations',
  'facts.rayfin.queries',
  'facts.rayfin.aggregates',
  'facts.rayfin.validators',
  'facts.rayfin.connectors',
  'facts.rayfin.dax',
  'facts.rayfin.functions',
  'facts.rayfin.secrets',
  'facts.rayfin.versions',
  'facts.rayfin.universalApp',
  'facts.rayfin.hosting',
  'facts.rayfin.files',
  'facts.rayfin.typeScript',
  'facts.rayfin.docs'
] as const

export const FABRICATOR_TIPS = [
  'facts.tip.describe',
  'facts.tip.design',
  'facts.tip.history',
  'facts.tip.advisor',
  'facts.tip.blueprint',
  'facts.tip.secrets',
  'facts.tip.publish',
  'facts.tip.autoPublish',
  'facts.tip.share',
  'facts.tip.help'
] as const

/**
 * True facts about rays. Their words are under `facts.ray` in the catalogs; the
 * English is in src/renderer/src/i18n/locales/en/mascot.json, where the Learn
 * Rayfin with Ray lessons take their ray facts from too.
 */
export const RAY_FACTS = [
  'facts.ray.cartilage',
  'facts.ray.rayFinned',
  'facts.ray.eyes',
  'facts.ray.electric',
  'facts.ray.fever',
  'facts.ray.mantaBrain',
  'facts.ray.mantaSpan'
] as const

export const QUIPS = [
  'facts.quip.school',
  'facts.quip.spots',
  'facts.quip.wings',
  'facts.quip.blink'
] as const

/**
 * What Ray keeps you company through: creating an app (`create`, which runs on
 * this computer; `team`, in a team workspace), cloning one, or installing an
 * opened app's packages.
 */
export type Occasion = 'create' | 'team' | 'clone' | 'prepare'

export function pickLine<T>(items: readonly T[], random: () => number = Math.random): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]
}

/** His opening line. The first one ever is an introduction. */
export function greeting(
  occasion: Occasion,
  firstTime: boolean,
  random: () => number = Math.random
): MascotLine {
  const t = translator('mascot')
  if (firstTime) {
    return {
      kind: 'chat',
      text: occasion === 'prepare' ? t('install.introPrepare') : t('install.intro')
    }
  }
  const create = [t('install.hello.create'), t('install.hello.createBack')]
  const lines: Record<Occasion, readonly string[]> = {
    create,
    team: create,
    clone: [t('install.hello.clone'), t('install.hello.cloneBack')],
    prepare: [t('install.hello.prepare'), t('install.hello.prepareBack')]
  }
  return { kind: 'chat', text: pickLine(lines[occasion], random) }
}

export function successLine(occasion: Occasion): MascotLine {
  const t = translator('mascot')
  const text =
    occasion === 'create'
      ? t('install.success.create')
      : occasion === 'team'
        ? t('install.success.team')
        : t('install.success.ready')
  return { kind: 'chat', text }
}

export function errorLine(occasion: Occasion): MascotLine {
  const t = translator('mascot')
  return {
    kind: 'chat',
    text: occasion === 'prepare' ? t('install.error.prepare') : t('install.error.details')
  }
}

const CHAT = {
  retry: 'install.retry',
  resume: 'install.resume',
  slow: 'install.slow',
  bye: 'install.bye'
} as const

/**
 * What he says when an install he's keeping you company through is retried
 * (`retry`), goes on to install more (`resume`) or takes a while (`slow`), and
 * when he's sent away (`bye`).
 */
export function chatLine(what: keyof typeof CHAT): MascotLine {
  return { kind: 'chat', text: text(CHAT[what]) }
}

const PLAY = {
  pet: [
    'play.pet.hehe',
    'play.pet.tickles',
    'play.pet.again',
    'play.pet.favorite',
    'play.pet.likeYou',
    'play.pet.wiggle'
  ],
  dizzy: ['play.dizzy.spinning', 'play.dizzy.tooMany'],
  lift: ['play.lift'],
  drop: ['play.drop.thanks', 'play.drop.niceSpot', 'play.drop.canFly'],
  hover: ['play.hover.hi', 'play.hover.hello', 'play.hover.psst'],
  wake: ['play.wake.up', 'play.wake.resting']
} as const

/**
 * Him being played with: petted (`dizzy` when it's too much), picked up
 * (`lift`) and put down (`drop`), the pointer coming by (`hover`), or woken.
 */
export type Play = keyof typeof PLAY

/** One of the things he says to `play`. */
export function playLine(play: Play, random: () => number = Math.random): string {
  return text(pickLine(PLAY[play], random))
}

const WORKING = [
  'help.working.logs',
  'help.working.clues',
  'help.working.docs',
  'help.working.source',
  'help.working.trail',
  'help.working.sand',
  'help.working.dots',
  'help.working.answer'
] as const

/** What Help is doing while it works, in Ray’s words. The first is plain. */
export const HELP_WORKING: readonly string[] = liveList(WORKING)

/** Ray’s hello in Help, by the time of day. */
export function helpGreeting(now: Date = new Date()): string {
  const t = translator('mascot')
  const hour = now.getHours()
  return hour >= 5 && hour < 12
    ? t('help.hello.morning')
    : hour >= 12 && hour < 17
      ? t('help.hello.afternoon')
      : hour >= 17 && hour < 22
        ? t('help.hello.evening')
        : t('help.hello.late')
}

/** Ray's hello on the loading screen. The first one ever is an introduction. */
export function splashGreeting(firstTime: boolean): string {
  const t = translator('mascot')
  return firstTime ? t('splash.intro') : t('splash.hello')
}

/**
 * Ray's hello when Fabricator opens straight into your work. Short: the app is
 * ready a moment later. Now and then it goes by the time of day.
 */
export function launchGreeting(now: Date = new Date(), random: () => number = Math.random): string {
  const t = translator('mascot')
  const hour = now.getHours()
  const timely =
    hour >= 5 && hour < 12
      ? t('splash.launch.morning')
      : hour >= 17 && hour < 22
        ? t('splash.launch.evening')
        : hour >= 22 || hour < 5
          ? t('splash.launch.late')
          : null
  return pickLine(
    [
      t('splash.launch.welcomeBack'),
      t('splash.launch.hey'),
      t('splash.launch.build'),
      ...(timely ? [timely] : [])
    ],
    random
  )
}

const SPLASH = {
  tools: ['splash.tools.toolbox', 'splash.tools.fins'],
  accounts: ['splash.accounts.knocking', 'splash.accounts.knuckles'],
  ready: ['splash.ready'],
  setup: ['splash.setup'],
  error: ['splash.error']
} as const satisfies Record<StartupStage, readonly string[]>

/**
 * What Ray says while Fabricator starts: a wink at each step, not its details.
 * When a step takes a while, he moves on to its next line.
 */
export const SPLASH_LINES: Record<StartupStage, readonly string[]> = liveLists(SPLASH)

/** Ray's hello on the publish screen. */
export function deployGreeting(name: string, firstDeploy: boolean): string {
  const t = translator('mascot')
  return firstDeploy ? t('deploy.helloFirst', { name }) : t('deploy.hello')
}

/** Ray's cheer when publishing is done. */
export function deployLiveLine(name: string): string {
  return translator('mascot')('deploy.live', { name })
}

/** Why publishing didn't finish, as far as what to offer goes. */
export type DeployTrouble = 'failed' | 'signin' | 'stopped' | 'unsupported'

const TROUBLE = {
  failed: 'deploy.trouble.failed',
  signin: 'deploy.trouble.signin',
  stopped: 'deploy.trouble.stopped',
  unsupported: 'deploy.trouble.unsupported'
} as const satisfies Record<DeployTrouble, string>

/**
 * What Ray says when publishing fails: what happened, in a sentence, and that
 * he can find out why. The details are a click away; he doesn't read them out.
 */
export const DEPLOY_TROUBLE_LINES: Record<DeployTrouble, string> = liveRecord(TROUBLE)

/** What Ray says when Fabric turned the app down in a workspace whose capacity is in `region`. */
export function unsupportedRegionLine(region: string): string {
  return translator('mascot')('deploy.trouble.unsupportedRegion', { region })
}

const DEPLOY = {
  packages: ['deploy.steps.packages', 'deploy.steps.suitcase'],
  connect: ['deploy.steps.hiFabric', 'deploy.steps.knock'],
  signin: ['deploy.steps.id'],
  capacity: ['deploy.steps.room', 'deploy.steps.pond'],
  workspace: ['deploy.steps.swimOver', 'deploy.steps.workspaceRoom'],
  item: ['deploy.steps.spot', 'deploy.steps.welcomeMat'],
  settings: ['deploy.steps.knobs', 'deploy.steps.guestList'],
  data: ['deploy.steps.tables', 'deploy.steps.tricks'],
  storage: ['deploy.steps.files', 'deploy.steps.shelves'],
  connectors: ['deploy.steps.plugging', 'deploy.steps.cables'],
  build: ['deploy.steps.building', 'deploy.steps.bundling', 'deploy.steps.current'],
  functions: ['deploy.steps.waking', 'deploy.steps.riseAndShine'],
  prepare: ['deploy.steps.ready', 'deploy.steps.welcomeMat'],
  package: ['deploy.steps.bow', 'deploy.steps.bundling'],
  upload: ['deploy.steps.current', 'deploy.steps.almost'],
  other: ['deploy.steps.magic', 'deploy.steps.new'],
  retry: ['deploy.steps.busy'],
  live: ['deploy.steps.live']
} as const satisfies Record<DeployTopic, readonly string[]>

/**
 * What Ray says while an app publishes: a wink at each step, not its details
 * (the step list has those). When a step takes a while, he moves on to its
 * next line, and on a long one he shares facts.
 */
export const DEPLOY_LINES: Record<DeployTopic, readonly string[]> = liveLists(DEPLOY)

/* ----------------------------- the deck ----------------------------- */

const DECK_KEY = 'fabricator.mascot.deck'
const MET_KEY = 'fabricator.mascot.met'

/** A line in a deck, by its key in the catalogs. */
export interface DeckCard {
  kind: Exclude<LineKind, 'chat'>
  key: (typeof RAYFIN_FACTS | typeof FABRICATOR_TIPS | typeof RAY_FACTS | typeof QUIPS)[number]
}

function cardsOf(kind: DeckCard['kind'], keys: readonly DeckCard['key'][]): DeckCard[] {
  return keys.map((key) => ({ kind, key }))
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/**
 * A fresh order for what Ray says: every Rayfin fact once, with a tip or a bit
 * of ray trivia after every two. Asides that don't fit come up in later decks,
 * since each deck shuffles them anew.
 */
export function buildDeck(random: () => number = Math.random): DeckCard[] {
  const facts = shuffle(cardsOf('rayfin', RAYFIN_FACTS), random)
  const extras = shuffle(
    [...cardsOf('tip', FABRICATOR_TIPS), ...cardsOf('ray', RAY_FACTS), ...cardsOf('quip', QUIPS)],
    random
  )
  const deck: DeckCard[] = []
  while (facts.length) {
    for (let i = 0; i < 2 && facts.length; i++) deck.push(facts.shift() as DeckCard)
    if (extras.length) deck.push(extras.shift() as DeckCard)
  }
  return deck
}

/** Every card, by key. */
const KNOWN = new Map<string, DeckCard>(
  [
    ...cardsOf('rayfin', RAYFIN_FACTS),
    ...cardsOf('tip', FABRICATOR_TIPS),
    ...cardsOf('ray', RAY_FACTS),
    ...cardsOf('quip', QUIPS)
  ].map((card) => [card.key, card])
)

/** Every card, by its English: decks saved before Ray spoke other languages hold that. */
let byEnglish: Map<string, DeckCard> | null = null

/** A saved card: its key, or `{ kind, text }` in English from an older build. */
function savedCard(saved: unknown): DeckCard | undefined {
  if (typeof saved === 'string') return KNOWN.get(saved)
  const english = (saved as { text?: unknown } | null)?.text
  if (typeof english !== 'string') return undefined
  const t = translator('mascot')
  byEnglish ??= new Map([...KNOWN.values()].map((card) => [t(card.key, { lng: 'en' }), card]))
  return byEnglish.get(english)
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* he'll just repeat himself next time */
  }
}

/**
 * Hands out lines without repeats, and remembers where it got to across
 * launches, so someone who installs often keeps hearing new things. It keeps
 * keys, so a line reads in the language shown when he says it.
 */
export class FactDeck {
  private cards: DeckCard[]

  constructor(private readonly random: () => number = Math.random) {
    this.cards = this.load()
  }

  next(): MascotLine {
    if (this.cards.length === 0) this.cards = buildDeck(this.random)
    const card = this.cards.shift() as DeckCard
    write(DECK_KEY, JSON.stringify(this.cards.map((c) => c.key)))
    return { kind: card.kind, text: text(card.key) }
  }

  private load(): DeckCard[] {
    try {
      const saved = JSON.parse(read(DECK_KEY) ?? '[]') as unknown
      if (Array.isArray(saved)) {
        // Drop anything a newer build reworded or removed.
        const cards = saved.map(savedCard).filter((c): c is DeckCard => c !== undefined)
        if (cards.length) return cards
      }
    } catch {
      /* start a fresh deck */
    }
    return buildDeck(this.random)
  }
}

/** True until Ray has introduced himself once. */
export function firstMeeting(): boolean {
  return read(MET_KEY) !== '1'
}

export function rememberMeeting(): void {
  write(MET_KEY, '1')
}
