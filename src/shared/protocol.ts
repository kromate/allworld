// The contract between the App and its world service: request/response operations plus the
// events the service pushes. Both sides import this file, so a mismatch is a type error.
import type {
  ApplicationId, CommunityId, DistrictId, HomeId, IntroId, ListingId, MatchId, MeetupId, MemberId,
  NotificationId, PostId, ProductId, QuoteId, RoomKey, SellerId, ShiftId, VariantId,
} from './ids.ts'
import type { Vec2 } from './geo.ts'
import type {
  AvatarLook, ChatMessage, CoarseArea, AreaSource, FaceAudience, FaceScan, MemberPreferences, MemberProfile, PresenceMember, PublicMember,
  ReportReason, RoomRef, RoomSnapshot,
} from './model.ts'
import type {
  CommunityDetail, CommunityRole, CommunitySummary, CommunityTopic, CommunityVisibility, Home, HomeLayout, Introduction,
  Meetup, NearbyMember, PublicVenue, VisitPolicy,
} from './social.ts'
import type {
  Audience, Board, BoardScope, Career, DashAttempt, DashInput, DashResult, GameKind, Match, Shift, TableAction, TableView, Workplace,
} from './play.ts'
import type { AdapterStatus, Channel, Delivery, ExternalChannel, Notification, NotifyCategory, NotifyPrefs, QuietHours } from './notify.ts'
import type {
  Application, ApplicationStatus, Availability, Fulfilment, Listing, ListingKind, Product, ProductCategory, Quote, Seller,
} from './market.ts'

import type { LedgerEntry, TravelQuote, TravelState } from './travel.ts'

import type { LifeEvent, LifeOps } from './life.ts'
import type { ArenaEvent, ArenaOps } from './arena.ts'
import type { DirectEvent, DirectOps } from './direct.ts'
import type { ComebackEvent, ComebackOps } from './comeback.ts'
import type { CreatorOps } from './creator.ts'
import type { VehicleEvent, VehicleOps } from './vehicles.ts'
import type { LiveCountsOps } from './liveCounts.ts'
import type { HomeEvent, HomeOps } from './homes.ts'

type Empty = Record<string, never>
type Op<In, Out> = { in: In; out: Out }

export interface VariantInput {
  id?: VariantId
  name: string
  material: string
  tints: Record<string, string>
  dimensionsCm: { width: number; depth: number; height: number }
  priceMinor: number | null
  currency: string
  availability: Availability
  leadTimeDays: number | null
}

export interface Ops extends LifeOps, DirectOps, ComebackOps, ArenaOps, CreatorOps, VehicleOps, LiveCountsOps, HomeOps {
  // ── Member ──
  'member.me': Op<Empty, { profile: MemberProfile; blocked: PublicMember[]; reviewer: boolean }>
  'member.saveProfile': Op<{ displayName: string; bio: string; look: AvatarLook; expectedRevision: number; clearFace?: boolean }, { profile: MemberProfile }>
  'member.savePreferences': Op<{ preferences: MemberPreferences }, { profile: MemberProfile }>
  'member.setCurrentArea': Op<{ area: CoarseArea; source: AreaSource }, { profile: MemberProfile }>
  'member.clearCurrentArea': Op<Empty, { profile: MemberProfile }>
  'member.setBrowsing': Op<{ area: CoarseArea | null }, { profile: MemberProfile }>
  'member.completeOnboarding': Op<Empty, { profile: MemberProfile }>
  'member.block': Op<{ memberId: MemberId }, { blocked: PublicMember[] }>
  'member.unblock': Op<{ memberId: MemberId }, { blocked: PublicMember[] }>
  'member.report': Op<{ memberId: MemberId; reason: ReportReason; detail: string; room: RoomKey | null }, { received: true }>
  'member.public': Op<{ memberId: MemberId }, { member: PublicMember }>
  /** Photo face: stored apart from the profile and served only to viewers inside its audience. */
  /** The photo and the whole look it was chosen with are one decision: both are kept, or neither. */
  'member.setFace': Op<{ scan: FaceScan; audience: FaceAudience; look: AvatarLook; expectedRevision: number }, { profile: MemberProfile }>
  'member.setFaceAudience': Op<{ audience: FaceAudience }, { profile: MemberProfile }>
  'member.clearFace': Op<Empty, { profile: MemberProfile }>
  'member.face': Op<{ memberId: MemberId; version: number }, { scan: FaceScan }>

  // ── Rooms, proximity text, voice signalling ──
  'room.enter': Op<{ ref: RoomRef; pos: Vec2; heading: number }, { snapshot: RoomSnapshot; history: ChatMessage[] }>
  'room.leave': Op<Empty, { left: true }>
  'room.move': Op<{ pos: Vec2; heading: number; moving: boolean }, { accepted: boolean; pos: Vec2 }>
  'chat.send': Op<{ text: string; clientId: string }, { message: ChatMessage }>
  'voice.set': Op<{ state: 'off' | 'live' | 'muted' }, { state: 'off' | 'live' | 'muted'; peers: MemberId[] }>
  'voice.signal': Op<{ to: MemberId; data: unknown }, { relayed: boolean }>

  // ── Nearby, introductions, friends ──
  'nearby.list': Op<Empty, { members: NearbyMember[]; areaLabel: string | null; stale: boolean; discoverable: boolean }>
  'intro.send': Op<{ to: MemberId; note: string }, { intro: Introduction }>
  'intro.respond': Op<{ introId: IntroId; accept: boolean }, { intro: Introduction }>
  'intro.withdraw': Op<{ introId: IntroId }, { intro: Introduction }>
  'intro.list': Op<Empty, { incoming: Introduction[]; outgoing: Introduction[] }>
  /**
   * The member's friends: everyone they accepted, and the friendships the service made (marked
   * `automatic`), newest of those first up to FRIENDS_AUTOMATIC_LISTED. `total` counts them all.
   */
  'friends.list': Op<Empty, { friends: PublicMember[]; total: number }>
  'friends.remove': Op<{ memberId: MemberId }, { friends: PublicMember[]; total: number }>

  // ── Communities ──
  'community.list': Op<Empty, { mine: CommunitySummary[]; discover: CommunitySummary[] }>
  'community.create': Op<{ name: string; about: string; topic: CommunityTopic; areaLabel: string; visibility: CommunityVisibility }, { community: CommunityDetail }>
  'community.get': Op<{ communityId: CommunityId }, { community: CommunityDetail }>
  'community.join': Op<{ communityId: CommunityId }, { community: CommunityDetail }>
  'community.leave': Op<{ communityId: CommunityId }, { left: true }>
  'community.invite': Op<{ communityId: CommunityId; memberId: MemberId }, { invited: true }>
  'community.post': Op<{ communityId: CommunityId; text: string }, { community: CommunityDetail }>
  'community.removePost': Op<{ communityId: CommunityId; postId: PostId }, { community: CommunityDetail }>
  'community.setRole': Op<{ communityId: CommunityId; memberId: MemberId; role: CommunityRole | 'removed' }, { community: CommunityDetail }>

  // ── Public meetups ──
  'meetup.list': Op<Empty, { meetups: Meetup[] }>
  'meetup.get': Op<{ meetupId: MeetupId }, { meetup: Meetup }>
  'meetup.propose': Op<{ venue: PublicVenue; startsAt: string; timezone: string; note: string; invite: MemberId[] }, { meetup: Meetup }>
  'meetup.respond': Op<{ meetupId: MeetupId; accept: boolean; revision: number }, { meetup: Meetup }>
  'meetup.revise': Op<{ meetupId: MeetupId; venue: PublicVenue; startsAt: string; timezone: string; note: string }, { meetup: Meetup }>
  'meetup.cancel': Op<{ meetupId: MeetupId }, { meetup: Meetup }>

  // ── Virtual homes ──
  'home.get': Op<{ homeId: HomeId | null }, { home: Home; canEdit: boolean }>
  'home.save': Op<{ layout: HomeLayout; name: string; expectedRevision: number }, { home: Home }>
  'home.setPolicy': Op<{ policy: VisitPolicy }, { home: Home }>
  'home.move': Op<{ districtLabel: string }, { home: Home }>
  'home.visitable': Op<Empty, { homes: { homeId: HomeId; owner: PublicMember; name: string; districtLabel: string; policy: VisitPolicy }[] }>

  // ── Travel, documents, wallet ──
  'travel.state': Op<Empty, { state: TravelState; ledger: LedgerEntry[] }>
  'travel.quote': Op<{ to: CoarseArea }, { quote: TravelQuote }>
  /** Pays the fare and starts the trip. The avatar arrives when the trip's time is up. */
  'travel.book': Op<{ to: CoarseArea }, { state: TravelState }>
  'travel.passportApply': Op<Empty, { state: TravelState }>
  'travel.visaApply': Op<{ countryCode: string; toward: CoarseArea }, { state: TravelState }>

  // ── Go to work (simulation) ──
  'work.places': Op<Empty, { workplaces: Workplace[]; career: Career; active: Shift | null }>
  'work.start': Op<{ workplaceId: string; venueName: string | null }, { shift: Shift }>
  'work.answer': Op<{ shiftId: ShiftId; index: number; handed: string[] }, { shift: Shift }>
  'work.leave': Op<{ shiftId: ShiftId }, { shift: Shift; career: Career }>
  'work.career': Op<Empty, { career: Career }>

  // ── Games ──
  'match.list': Op<Empty, { matches: Match[] }>
  'match.get': Op<{ matchId: MatchId }, { match: Match; table: TableView | null; viewer: 'player' | 'spectator' | 'outsider' }>
  'match.create': Op<{ game: GameKind; invite: MemberId[]; audience: Audience; communityId: CommunityId | null }, { match: Match }>
  'match.respond': Op<{ matchId: MatchId; accept: boolean }, { match: Match }>
  'match.rematch': Op<{ matchId: MatchId }, { match: Match }>
  'match.open': Op<Empty, { matches: Match[] }>
  'dash.begin': Op<{ matchId: MatchId | null }, { attempt: DashAttempt }>
  'dash.submit': Op<{ attemptToken: string; inputs: DashInput[] }, DashResult>
  'table.act': Op<{ matchId: MatchId; action: TableAction }, { table: TableView }>
  'table.watch': Op<{ matchId: MatchId }, { table: TableView; match: Match }>
  'board.get': Op<{ scope: BoardScope; game: GameKind; communityId: CommunityId | null }, { board: Board }>

  // ── Notifications ──
  'notify.list': Op<{ includeRead: boolean }, { notifications: Notification[]; unread: number }>
  'notify.open': Op<{ notificationId: NotificationId }, { notification: Notification }>
  'notify.readAll': Op<{ category: NotifyCategory | null }, { unread: number }>
  'notify.prefs': Op<Empty, { prefs: NotifyPrefs; adapters: AdapterStatus[] }>
  'notify.setCategory': Op<{ category: NotifyCategory; channel: Channel; enabled: boolean }, { prefs: NotifyPrefs }>
  'notify.setQuietHours': Op<{ quietHours: QuietHours }, { prefs: NotifyPrefs }>
  'notify.setConsent': Op<{ channel: ExternalChannel; granted: boolean; destination: string }, { prefs: NotifyPrefs }>
  'notify.setReminderDelay': Op<{ minutes: number }, { prefs: NotifyPrefs }>
  'notify.deliveries': Op<Empty, { deliveries: Delivery[]; adapters: AdapterStatus[] }>

  // ── Real products and quotes ──
  'market.catalog': Op<{ category: ProductCategory | null; query: string; savedOnly: boolean }, { products: Product[] }>
  'market.product': Op<{ productId: ProductId }, { product: Product }>
  'market.byModel': Op<{ model: string }, { products: Product[] }>
  'market.save': Op<{ productId: ProductId; saved: boolean }, { product: Product }>
  'market.sellerApply': Op<{ name: string; about: string; areaLabel: string }, { seller: Seller }>
  'market.mySeller': Op<Empty, { seller: Seller | null; products: Product[] }>
  'market.sellerQueue': Op<Empty, { sellers: Seller[] }>
  'market.sellerReview': Op<{ sellerId: SellerId; approve: boolean }, { seller: Seller }>
  'market.productSave': Op<{
    productId: ProductId | null; name: string; description: string; category: ProductCategory; model: string
    variants: VariantInput[]; sharingAllowed: boolean; commissionNote: string | null; listed: boolean
  }, { product: Product }>
  'quote.request': Op<{ productId: ProductId; variantId: VariantId; quantity: number; note: string; referredBy: MemberId | null }, { quote: Quote }>
  'quote.list': Op<Empty, { asBuyer: Quote[]; asSeller: Quote[] }>
  'quote.get': Op<{ quoteId: QuoteId }, { quote: Quote }>
  'quote.offer': Op<{ quoteId: QuoteId; priceMinor: number; currency: string; leadTimeDays: number; note: string }, { quote: Quote }>
  'quote.decide': Op<{ quoteId: QuoteId; accept: boolean; fulfilment: Fulfilment | null }, { quote: Quote }>
  'quote.withdraw': Op<{ quoteId: QuoteId }, { quote: Quote }>

  // ── Real jobs and member tasks ──
  'listing.list': Op<{ kind: ListingKind | null; mine: boolean }, { listings: Listing[] }>
  'listing.get': Op<{ listingId: ListingId }, { listing: Listing }>
  'listing.save': Op<{
    listingId: ListingId | null; kind: ListingKind; title: string; organisation: string; description: string
    areaLabel: string; remote: boolean; compensation: string
  }, { listing: Listing }>
  'listing.setStatus': Op<{ listingId: ListingId; status: 'open' | 'filled' | 'closed' }, { listing: Listing }>
  'application.submit': Op<{ listingId: ListingId; message: string; contact: string }, { application: Application }>
  'application.mine': Op<Empty, { applications: Application[] }>
  'application.forListing': Op<{ listingId: ListingId }, { applications: Application[] }>
  'application.decide': Op<{ applicationId: ApplicationId; status: Exclude<ApplicationStatus, 'submitted'> }, { application: Application }>
}

export type OpName = keyof Ops
export const OP_NAMES_WITHOUT_REPLY: ReadonlySet<OpName> = new Set<OpName>([])

// ── Events pushed by the service ──────────────────────────────────────────────────────────────

export type ServerEvent =
  | LifeEvent
  | DirectEvent
  | ComebackEvent
  | ArenaEvent
  | VehicleEvent
  | HomeEvent
  | { type: 'presence.join'; room: RoomKey; member: PresenceMember }
  | { type: 'presence.leave'; room: RoomKey; memberId: MemberId }
  | { type: 'presence.move'; room: RoomKey; memberId: MemberId; pos: Vec2; heading: number; moving: boolean }
  | { type: 'presence.update'; room: RoomKey; member: PresenceMember }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'voice.peers'; room: RoomKey; peers: MemberId[] }
  | { type: 'voice.signal'; from: MemberId; data: unknown }
  | { type: 'notify.new'; notification: Notification; unread: number }
  | { type: 'notify.changed'; unread: number }
  | { type: 'match.changed'; matchId: MatchId }
  | { type: 'table.state'; matchId: MatchId; table: TableView }
  | { type: 'social.changed'; scope: 'intros' | 'friends' | 'communities' | 'meetups' | 'homes' | 'quotes' | 'listings' }
  | { type: 'travel.changed'; state: TravelState }
  | { type: 'session.replaced' }

// ── Wire envelopes ────────────────────────────────────────────────────────────────────────────

/**
 * Optional abilities a client announces in `hello`. A service only uses one the client named,
 * so a client that sends none is served exactly as before.
 *   'batch' — movement arrives as `{ t: 'batch' }` frames instead of one `presence.move` event each.
 */
export type ClientCapability = 'batch'

/** One avatar's movement inside a batch frame: member, x, z, heading, moving (1 or 0). */
export type MoveTuple = [memberId: MemberId, x: number, z: number, heading: number, moving: 0 | 1]

export type ClientFrame =
  | { t: 'hello'; token: string; resume: { ref: RoomRef; pos: Vec2; heading: number } | null; caps?: ClientCapability[] }
  | { t: 'req'; id: number; op: OpName; input: unknown }
  | { t: 'ping' }

export type ServerFrame =
  | { t: 'welcome'; memberId: MemberId; serverTime: string; build: string }
  | { t: 'denied'; code: string; message: string }
  | { t: 'res'; id: number; ok: true; data: unknown }
  | { t: 'res'; id: number; ok: false; code: string; message: string }
  | { t: 'event'; event: ServerEvent }
  /**
   * Only sent to a connection that announced 'batch'. Everything one room step changed around
   * the member: apply `events` in order, then treat each entry of `m` as a `presence.move` in `room`.
   */
  | { t: 'batch'; room: RoomKey; m: MoveTuple[]; events: ServerEvent[] }
  | { t: 'pong' }

export const WORLD_PATH = '/world'
export type { DistrictId }
