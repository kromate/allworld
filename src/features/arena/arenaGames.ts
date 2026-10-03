// The pieces each game brings to the hall, found by file name so the hall works with whichever
// games have landed: `games/<game>/Board.vue` (required to play) and `games/<game>/HowTo.vue`
// (optional: the game's own how-to-play; without it the hall shows its short written one).
import { defineAsyncComponent } from 'vue'
import type { Component } from 'vue'
import type { ArenaGame } from '../../shared/arena.ts'

const boards = import.meta.glob<{ default: Component }>('./games/*/Board.vue')
const howTos = import.meta.glob<{ default: Component }>('./games/*/HowTo.vue')
const made = new Map<string, Component>()

function lazy(loaders: Record<string, () => Promise<{ default: Component }>>, path: string): Component | null {
  const loader = loaders[path]
  if (!loader) return null
  let component = made.get(path)
  if (!component) { component = defineAsyncComponent(loader); made.set(path, component) }
  return component
}

export const boardFor = (game: ArenaGame): Component | null => lazy(boards, `./games/${game}/Board.vue`)
export const howToFor = (game: ArenaGame): Component | null => lazy(howTos, `./games/${game}/HowTo.vue`)
export const hasBoard = (game: ArenaGame): boolean => `./games/${game}/Board.vue` in boards
