import { translator } from './i18n'

/**
 * Project names follow the Rayfin CLI's rule (`isValidProjectName`), which
 * rejects anything else when the project is created: letters, numbers, spaces,
 * hyphens and underscores, with at least one letter or number.
 */
const ALLOWED = /^[A-Za-z0-9\s_-]+$/

/** Why `name` can't name a project, or null when it can (or is still blank). */
export function projectNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (!ALLOWED.test(trimmed)) return translator('home')('projectName.characters')
  if (!/[A-Za-z0-9]/.test(trimmed)) return translator('home')('projectName.letterOrNumber')
  return null
}

/** A valid project name from any text, such as a report's name: accents dropped, other characters made spaces. */
export function toProjectName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9\s_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// What a new project is called until it's renamed: silly, safe for work, and
// unlikely to be taken. Letters only, so every name is one the Rayfin CLI takes.
const ADJECTIVES = `
  Bashful Bouncy Breezy Bubbly Caffeinated Cheeky Cosmic Crunchy Dapper Dizzy Fancy Fizzy
  Fluffy Funky Giggly Gleeful Glittery Goofy Grumpy Hungry Jazzy Jolly Lucky Majestic Mellow
  Mischievous Nifty Peppy Perky Plucky Quirky Rowdy Sassy Sleepy Snazzy Sneaky Sparkly Speedy
  Spunky Squishy Swanky Toasty Turbo Twinkly Wacky Whimsical Wiggly Wobbly Zany Zesty Zippy
`
  .trim()
  .split(/\s+/)
const NOUNS = `
  Alpaca Avocado Badger Banjo Barnacle Burrito Capybara Cupcake Dumpling Flamingo Hedgehog
  Jellyfish Kazoo Koala Llama Lobster Manatee Marshmallow Muffin Narwhal Noodle Nugget Octopus
  Otter Pancake Panda Pelican Penguin Pickle Platypus Pretzel Puffin Quokka Raccoon Robot
  Seahorse Sloth Spatula Squid Stingray Taco Teapot Toucan Trombone Ukulele Unicorn Waffle
  Walrus Wombat Yeti
`
  .trim()
  .split(/\s+/)

/** A random name for a new project, such as "Caffeinated Narwhal". `random` returns 0 ≤ n < 1. */
export function funnyProjectName(random: () => number = Math.random): string {
  const pick = (words: string[]): string =>
    words[Math.min(words.length - 1, Math.floor(random() * words.length))]
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`
}
