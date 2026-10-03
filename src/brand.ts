// Shared player-facing identity. Keep the manifest and browser title aligned with this name.
export const brand = {
  name: 'Allworld',
  shortName: 'Allworld',
  provisional: false,
  tagline: 'Walk your real streets, meet people nearby, play together.',
  slug: 'allworld',
  version: '0.1.0',
  /** Matches the amber mark in src/ui/BrandMark.vue. */
  accent: '#ffb020',
  accentInk: '#241a05',
  supportUrl: 'https://goalmatic.io/support',
} as const

export const brandTitle = (page?: string): string => (page ? `${page} · ${brand.name}` : brand.name)
