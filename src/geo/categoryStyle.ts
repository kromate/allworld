/** Emoji and accent per map category, for venue signs. */
export const CATEGORY_STYLE: Record<string, { icon: string; color: string }> = {
  cafe: { icon: '☕', color: '#b86b3c' }, restaurant: { icon: '🍽', color: '#d2553f' }, fast_food: { icon: '🍔', color: '#e0762f' },
  bar: { icon: '🍹', color: '#a2489c' }, beer: { icon: '🍺', color: '#c78a1b' }, shop: { icon: '🛍', color: '#2f84c4' },
  grocery: { icon: '🧺', color: '#3f9d5d' }, clothing_store: { icon: '👕', color: '#7a5fd0' }, bakery: { icon: '🥐', color: '#c58a3d' },
  bank: { icon: '🏦', color: '#3c6fa8' }, school: { icon: '🏫', color: '#d49a1e' }, college: { icon: '🎓', color: '#8a62c9' },
  library: { icon: '📚', color: '#4f7fc0' }, park: { icon: '🌳', color: '#3d9a55' }, hospital: { icon: '🏥', color: '#d9534f' },
  pharmacy: { icon: '💊', color: '#2ba58b' }, lodging: { icon: '🛏', color: '#6b78c9' }, bus: { icon: '🚌', color: '#2a8dbd' },
  railway: { icon: '🚆', color: '#51607a' }, place_of_worship: { icon: '🕊', color: '#8a8f9c' }, cinema: { icon: '🎬', color: '#c0457a' },
  theatre: { icon: '🎭', color: '#b2485c' }, art_gallery: { icon: '🖼', color: '#bb5f9a' }, museum: { icon: '🏛', color: '#9b7a4d' },
  stadium: { icon: '🏟', color: '#3f8f6b' }, pitch: { icon: '⚽', color: '#3f8f6b' }, fuel: { icon: '⛽', color: '#6a7483' },
  town_hall: { icon: '🏛', color: '#7d6c56' }, post: { icon: '📮', color: '#c24a3b' }, music: { icon: '🎵', color: '#9655c8' },
  office: { icon: '🏢', color: '#5c7391' }, mall: { icon: '🛒', color: '#2f84c4' }, hairdresser: { icon: '💈', color: '#cf5a7b' },
}
export const categoryStyle = (category: string): { icon: string; color: string } => CATEGORY_STYLE[category] ?? { icon: '📍', color: '#e2572b' }

