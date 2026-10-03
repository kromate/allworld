// The only module this entry loads before its own body runs: it takes a transfer link's one-use
// code out of the address (src/platform/transferFragment.ts). Everything else is loaded inside
// `mount()`, after it has run. A static import here would be evaluated first, and a bundler may
// hoist it into a shared chunk that runs before this file, so the rest stays dynamic on purpose.
import './src/platform/transferFragment.ts'
import type { RouteRecordRaw } from 'vue-router'

// Real path routes. The world itself is always mounted; every other route opens a panel beside it.
// `nav` names the section a route sits under when its path does not (src/ui/shell.ts). `half` is a
// page that works on the scene: on a phone it takes the lower half and the world stays live above it.
// `gate` marks a section every part of which is closed to a guest by the service's policy
// (src/shared/guest.ts): for a guest the shell shows why, and the way to save, instead of the page.
// The game hall and the older games stay open to a guest: play against the computer and a solo run are allowed.
const routes: RouteRecordRaw[] = [
  { path: '/', component: () => import('./src/features/world/WorldRoute.vue'), meta: { title: '' } },
  { path: '/feedback', component: () => import('./src/features/feedback/FeedbackPage.vue'), meta: { title: 'Noticeboard' } },
  { path: '/people', component: () => import('./src/features/people/PeoplePage.vue'), meta: { title: 'People', gate: 'social' } },
  { path: '/people/meetups/:id', component: () => import('./src/features/people/MeetupPage.vue'), meta: { title: 'Meetup', gate: 'social' } },
  { path: '/communities', component: () => import('./src/features/people/CommunitiesPage.vue'), meta: { title: 'Communities', gate: 'social' } },
  { path: '/communities/:id', component: () => import('./src/features/people/CommunityPage.vue'), meta: { title: 'Community', gate: 'social' } },
  { path: '/work', component: () => import('./src/features/play/WorkPage.vue'), meta: { title: 'Go to work', wide: true } },
  { path: '/games', component: () => import('./src/features/play/GamesPage.vue'), meta: { title: 'Games', wide: true, nav: '/arena' } },
  { path: '/games/match/:id', component: () => import('./src/features/play/MatchPage.vue'), meta: { title: 'Match', wide: true, nav: '/arena', gate: 'competition' } },
  { path: '/arena', component: () => import('./src/features/arena/ArenaPage.vue'), meta: { title: 'Game hall', wide: true } },
  { path: '/arena/match/:id', component: () => import('./src/features/arena/ArenaMatch.vue'), meta: { title: 'Match', wide: true, full: true } },
  { path: '/arena/lab/:game', component: () => import('./src/features/arena/ArenaLab.vue'), meta: { title: 'Practice board', wide: true, full: true } },
  { path: '/market', component: () => import('./src/features/market/MarketPage.vue'), meta: { title: 'Market', wide: true, gate: 'marketplace' } },
  { path: '/market/p/:id', component: () => import('./src/features/market/ProductPage.vue'), meta: { title: 'Product', wide: true, gate: 'marketplace' } },
  { path: '/market/quotes', component: () => import('./src/features/market/QuotesPage.vue'), meta: { title: 'Quotes', wide: true, gate: 'marketplace' } },
  { path: '/market/quotes/:id', component: () => import('./src/features/market/QuotePage.vue'), meta: { title: 'Quote', wide: true, gate: 'marketplace' } },
  { path: '/market/sell', component: () => import('./src/features/market/SellPage.vue'), meta: { title: 'Sell', wide: true, gate: 'marketplace' } },
  { path: '/jobs', component: () => import('./src/features/market/JobsPage.vue'), meta: { title: 'Jobs and tasks', wide: true, gate: 'application' } },
  { path: '/jobs/:id', component: () => import('./src/features/market/JobPage.vue'), meta: { title: 'Listing', wide: true, gate: 'application' } },
  { path: '/travel', component: () => import('./src/features/travel/TravelPage.vue'), meta: { title: 'Travel', wide: true } },
  { path: '/messages', component: () => import('./src/features/social/MessagesPage.vue'), meta: { title: 'Messages', wide: true, gate: 'messaging' } },
  { path: '/messages/:id', component: () => import('./src/features/social/MessagesPage.vue'), meta: { title: 'Messages', wide: true, gate: 'messaging' } },
  { path: '/map', component: () => import('./src/features/map/MapPage.vue'), meta: { title: 'Map', wide: true, full: true } },
  { path: '/inbox', component: () => import('./src/features/inbox/InboxPage.vue'), meta: { title: 'Inbox' } },
  { path: '/inbox/:id', component: () => import('./src/features/inbox/InboxOpen.vue'), meta: { title: 'Inbox' } },
  { path: '/home', component: () => import('./src/features/world/HomePage.vue'), meta: { title: 'My home', half: true } },
  { path: '/downloads', component: () => import('./src/features/settings/DownloadsPage.vue'), meta: { title: 'Downloads & storage', wide: true, nav: '/settings' } },
  { path: '/settings', component: () => import('./src/features/settings/SettingsPage.vue'), meta: { title: 'Settings', wide: true } },
  { path: '/save', component: () => import('./src/features/guest/GuestSavePage.vue'), meta: { title: 'Save my character', nav: '/settings' } },
  { path: '/:pathMatch(.*)*', component: () => import('./src/ui/NotFound.vue'), meta: { title: 'Not found' } },
]

async function mount(): Promise<void> {
  const [{ createApp }, { createRouter, createWebHistory }, { resolveDownloadEntry }, { brandTitle }] = await Promise.all([
    import('vue'), import('vue-router'), import('./src/platform/downloadEntry.ts'), import('./src/brand.ts'), import('./src/ui/base.css'),
  ])
  const downloadEntry = resolveDownloadEntry(location.href, import.meta.url, import.meta.env.BASE_URL)
  const router = createRouter({ history: downloadEntry ? createWebHistory(downloadEntry.basePath) : createWebHistory(), routes })
  router.afterEach(to => { document.title = brandTitle(typeof to.meta.title === 'string' && to.meta.title ? to.meta.title : undefined) })
  if (downloadEntry) {
    const { default: PublicDownloadsEntry } = await import('./src/features/settings/PublicDownloadsEntry.vue')
    createApp(PublicDownloadsEntry, { entry: downloadEntry }).use(router).mount('#app')
  } else {
    const { default: App } = await import('./App.vue')
    createApp(App).use(router).mount('#app')
  }
}
void mount()
