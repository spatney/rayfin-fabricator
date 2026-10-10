/**
 * What Ray says.
 *
 * Rayfin facts are checked against the Rayfin docs (rayfin.ai, v1.36), tips
 * against Fabricator itself, and ray facts against marine-biology sources —
 * keep them true when any of those change. Lines stay short: he's a stingray
 * in a speech bubble, not a manual.
 */

export type LineKind = 'rayfin' | 'tip' | 'ray' | 'quip' | 'chat'

export interface MascotLine {
  kind: LineKind
  text: string
}

/** The small label above a line, when it has one. */
export function lineLabel(kind: LineKind): string | null {
  switch (kind) {
    case 'rayfin':
      return 'Rayfin fact'
    case 'tip':
      return 'Fabricator tip'
    case 'ray':
      return 'Ray fact'
    default:
      return null
  }
}

export const RAYFIN_FACTS: readonly string[] = [
  'Rayfin turns TypeScript classes into a database, APIs and a type-safe client.',
  'Your data model is plain TypeScript. Decorators like @text, @int and @date describe each field.',
  'One command, rayfin up, deploys the whole app to Microsoft Fabric.',
  'Rayfin apps run on Microsoft Fabric, inside your organization’s boundary.',
  'Sign-in comes built in: Rayfin apps sign people in with Microsoft Entra ID.',
  'A policy on @authenticated can show each person only their own rows. Row-level security, in one line.',
  '@one and @many link entities, so a customer can have many orders.',
  'Rayfin queries are type-safe chains: select, where, orderBy, then execute.',
  'Need totals? groupBy() and aggregate() handle sums, averages and counts.',
  'Rayfin can generate a validator from an entity, so a form can check input before it’s saved.',
  'Connectors read data that already lives in Fabric: warehouses, SQL databases, semantic models and KQL databases.',
  'With a connector, your app can run DAX against a Fabric semantic model.',
  'Functions run server-side TypeScript next to your data. Heads up: they aren’t in every Fabric region yet.',
  'Functions can call outside APIs using secrets you store with rayfin secret set.',
  'Every @microsoft/rayfin-* package shares one version number, so upgrades move in lockstep.',
  'New apps start from Rayfin’s Universal App. It starts small and grows into whatever you describe.',
  'Rayfin hosts your frontend too. The built app is served from Fabric, next to its data.',
  'While you build, rayfin dev keeps the backend in Fabric and runs the frontend on your machine.',
  'Rayfin is TypeScript all the way down: data model, client code and app logic.',
  'Rayfin’s docs are written for agents too. Add .md to any page on rayfin.ai to get it as Markdown.'
]

export const FABRICATOR_TIPS: readonly string[] = [
  'Describe what you want in plain English. Copilot writes the code, and I cheer.',
  'In the preview, Design lets you point at anything and ask for a change.',
  'Every change is kept. Code → History can restore an earlier version.',
  'The Advisor grades your app’s health, and every finding comes with a one-click fix.',
  'Blueprint shows how your app is put together, data model included.',
  'After each successful chat turn, Fabricator redeploys your app for you.',
  'Once your app is deployed, Share lets people in your organization open it.',
  'Stuck later? Select Help in the status bar, and I’ll dig through the logs with you.'
]

export const RAY_FACTS: readonly string[] = [
  'Rays are cousins of sharks. Our skeletons are cartilage, not bone.',
  'Plot twist: despite the name, rays aren’t ray-finned fish. We’re closer to sharks.',
  'A stingray’s eyes are on top and its mouth is underneath, so it can watch while it eats.',
  'Rays can sense the faint electric fields of prey hiding in the sand.',
  'A group of stingrays is called a fever. I’m not making that up.',
  'Manta rays have the biggest brains of any fish.',
  'The giant manta ray can grow about 7 meters from wingtip to wingtip.'
]

export const QUIPS: readonly string[] = [
  'A group of fish is a school. A group of packages is node_modules.',
  'I tried counting the packages npm is fetching. I ran out of spots.',
  'I’d carry some packages, but I’m all wings.',
  'Most fish can’t blink. I practiced.'
]

export type Occasion = 'create' | 'clone' | 'prepare'

export function pickLine<T>(items: readonly T[], random: () => number = Math.random): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]
}

/** His opening line. The first one ever is an introduction. */
export function greeting(
  occasion: Occasion,
  firstTime: boolean,
  random: () => number = Math.random
): MascotLine {
  if (firstTime) {
    const what =
      occasion === 'prepare'
        ? 'While this app gets its packages'
        : 'While npm fetches your packages'
    return { kind: 'chat', text: `Hi, I’m Ray! ${what}, I’ll tell you about Rayfin.` }
  }
  const lines: Record<Occasion, readonly string[]> = {
    create: [
      'Ooh, a new app! I’ll share some Rayfin facts while npm does its thing.',
      'Welcome back! New app, new packages. I’ll keep you company.'
    ],
    clone: [
      'Cloning, nice. I’ll keep you company while the packages arrive.',
      'Welcome back! I’ll share some Rayfin facts while this installs.'
    ],
    prepare: [
      'This app needs its packages first. I’ll keep you company.',
      'Welcome back! A quick install, then you’re in.'
    ]
  }
  return { kind: 'chat', text: pickLine(lines[occasion], random) }
}

export function successLine(occasion: Occasion): MascotLine {
  return {
    kind: 'chat',
    text:
      occasion === 'create'
        ? 'Your app is ready! Next, pick a Fabric workspace to deploy it.'
        : 'All set! Your app is ready.'
  }
}

export function errorLine(occasion: Occasion): MascotLine {
  return {
    kind: 'chat',
    text:
      occasion === 'prepare'
        ? 'Oh no, that didn’t work. The message says why. Retry, or ask Help to dig in.'
        : 'Oh no, that didn’t work. The details show why, and Help can dig in.'
  }
}

export const RETRY_LINE: MascotLine = { kind: 'chat', text: 'Round two. I believe in you.' }

export const RESUME_LINE: MascotLine = { kind: 'chat', text: 'Oh! More to install. I’ll stay.' }

export const PET_LINES: readonly string[] = [
  'Hehe!',
  'That tickles!',
  'Again! Again!',
  'You’re my favorite human.',
  'I like you too.',
  'Happy wiggle!'
]

export const DIZZY_LINES: readonly string[] = ['Whoa… the room is spinning.', 'Too… many… pets…']

export const LIFT_LINE = 'Wheee!'

export const DROP_LINES: readonly string[] = [
  'Thanks for the lift!',
  'Ooh, nice spot.',
  'I can fly, you know. Underwater. But thanks.'
]

export const HOVER_LINES: readonly string[] = ['Oh, hi!', 'Hello there.', 'Psst. You can pet me.']

export const WAKE_LINES: readonly string[] = [
  'Huh? I’m up! I’m up.',
  'I wasn’t asleep. I was resting my wings.'
]

export const BYE_LINE: MascotLine = {
  kind: 'chat',
  text: 'Okay, bye for now! I’ll be in Help if you need me.'
}

export const SLOW_LINE: MascotLine = { kind: 'chat', text: 'npm is being extra thorough today.' }

/** What Help is doing while it works, in Ray’s words. The first is plain. */
export const HELP_WORKING: readonly string[] = [
  'looking through your logs',
  'fishing for clues',
  'gliding through the docs',
  'reading the source',
  'following the trail',
  'sifting through the sand',
  'connecting the dots',
  'reeling in an answer'
]

/** Ray’s hello in Help, by the time of day. */
export function helpGreeting(now: Date = new Date()): string {
  const hour = now.getHours()
  const hello =
    hour >= 5 && hour < 12
      ? 'Good morning!'
      : hour >= 12 && hour < 17
        ? 'Good afternoon!'
        : hour >= 17 && hour < 22
          ? 'Good evening!'
          : 'Up late? Me too.'
  return `${hello} I’m Ray.`
}

/* ----------------------------- the deck ----------------------------- */

const DECK_KEY = 'fabricator.mascot.deck'
const MET_KEY = 'fabricator.mascot.met'

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
export function buildDeck(random: () => number = Math.random): MascotLine[] {
  const facts = shuffle(RAYFIN_FACTS, random).map((text): MascotLine => ({ kind: 'rayfin', text }))
  const extras = shuffle(
    [
      ...FABRICATOR_TIPS.map((text): MascotLine => ({ kind: 'tip', text })),
      ...RAY_FACTS.map((text): MascotLine => ({ kind: 'ray', text })),
      ...QUIPS.map((text): MascotLine => ({ kind: 'quip', text }))
    ],
    random
  )
  const deck: MascotLine[] = []
  while (facts.length) {
    for (let i = 0; i < 2 && facts.length; i++) deck.push(facts.shift() as MascotLine)
    if (extras.length) deck.push(extras.shift() as MascotLine)
  }
  return deck
}

const KNOWN = new Set<string>([...RAYFIN_FACTS, ...FABRICATOR_TIPS, ...RAY_FACTS, ...QUIPS])

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
 * launches, so someone who installs often keeps hearing new things.
 */
export class FactDeck {
  private cards: MascotLine[]

  constructor(private readonly random: () => number = Math.random) {
    this.cards = this.load()
  }

  next(): MascotLine {
    if (this.cards.length === 0) this.cards = buildDeck(this.random)
    const card = this.cards.shift() as MascotLine
    write(DECK_KEY, JSON.stringify(this.cards))
    return card
  }

  private load(): MascotLine[] {
    try {
      const saved = JSON.parse(read(DECK_KEY) ?? '[]') as unknown
      if (Array.isArray(saved)) {
        // Drop anything a newer build reworded or removed.
        const cards = saved.filter(
          (c): c is MascotLine =>
            Boolean(c) &&
            typeof c.text === 'string' &&
            typeof c.kind === 'string' &&
            KNOWN.has(c.text)
        )
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
