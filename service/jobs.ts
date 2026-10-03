// Real job listings and member tasks, with real applications. Separate from the simulated careers:
// nothing here reads or stores career level, points or skills, and no money moves — compensation is
// the owner's own free text.
import type { ApplicationId, Iso, ListingId, MemberId } from '../src/shared/ids.ts'
import { iso, newId } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import type { Application, ApplicationStatus, Listing, ListingKind, ListingStatus } from '../src/shared/market.ts'
import type { World } from './kernel.ts'
import { requireFound } from './kernel.ts'
import { isBlockedEitherWay, tryPublicMember } from './members.ts'
import { emit } from './notify.ts'
import { bool, empty, id, obj, oneOf, optId, str } from './parse.ts'

interface ListingRecord {
  id: ListingId; kind: ListingKind; owner: MemberId; title: string; organisation: string; description: string
  areaLabel: string; remote: boolean; compensation: string; status: ListingStatus; createdAt: Iso; updatedAt: Iso
}
interface ApplicationRecord {
  id: ApplicationId; listingId: ListingId; applicant: MemberId; message: string; contact: string
  status: ApplicationStatus; createdAt: Iso; decidedAt: Iso | null
}
interface JobsState { listings: Record<string, ListingRecord>; applications: Record<string, ApplicationRecord> }

const state = (world: World): JobsState => world.slice<JobsState>('jobs', () => ({ listings: {}, applications: {} }))
const forbidden = (message: string): never => { throw new WorldError('forbidden', message) }
const applicationsOf = (world: World, listingId: ListingId): ApplicationRecord[] => Object.values(state(world).applications).filter(app => app.listingId === listingId)
/** An active (not withdrawn) application wins over history whatever the timestamps say; only then the newest one. */
function mineOn(world: World, listingId: ListingId, memberId: MemberId): ApplicationRecord | undefined {
  const own = applicationsOf(world, listingId).filter(app => app.applicant === memberId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return own.findLast(app => app.status !== 'withdrawn') ?? own.at(-1)
}

function listingView(world: World, viewer: MemberId, listing: ListingRecord): Listing | null {
  const owner = tryPublicMember(world, viewer, listing.owner)
  if (!owner) return null
  return {
    id: listing.id, kind: listing.kind, owner, title: listing.title, organisation: listing.organisation, description: listing.description,
    areaLabel: listing.areaLabel, remote: listing.remote, compensation: listing.compensation, status: listing.status, createdAt: listing.createdAt,
    applicationCount: viewer === listing.owner ? applicationsOf(world, listing.id).filter(app => app.status !== 'withdrawn').length : null,
    myApplication: mineOn(world, listing.id, viewer)?.status ?? null,
  }
}

/** Only the owner, or someone who applied, can read a listing that is no longer open. */
const mayRead = (world: World, viewer: MemberId, listing: ListingRecord): boolean =>
  listing.owner === viewer || (!isBlockedEitherWay(world, viewer, listing.owner) && (listing.status === 'open' || Boolean(mineOn(world, listing.id, viewer))))

function applicationView(world: World, viewer: MemberId, app: ApplicationRecord): Application | null {
  const listing = state(world).listings[app.listingId]
  // Exactly two people can read an application: the applicant and the listing owner.
  if (!listing || (viewer !== app.applicant && viewer !== listing.owner)) return null
  const applicant = tryPublicMember(world, viewer, app.applicant)
  if (!applicant) return null
  return {
    id: app.id, listing: { id: listing.id, title: listing.title, kind: listing.kind, organisation: listing.organisation }, applicant,
    message: app.message, contact: app.contact, status: app.status, createdAt: app.createdAt, decidedAt: app.decidedAt,
  }
}

const findListing = (world: World, listingId: ListingId): ListingRecord => requireFound(state(world).listings[listingId], 'That listing')
const pushListings = (world: World, ...members: MemberId[]): void => { for (const memberId of new Set(members)) world.push(memberId, { type: 'social.changed', scope: 'listings' }) }

export function registerJobs(world: World): void {
  world.register('listing.list', value => {
    const raw = obj(value)
    return { kind: raw.kind === null || raw.kind === undefined ? null : oneOf(raw, 'kind', ['job', 'task'] as const), mine: bool(raw, 'mine') }
  }, (ctx, input) => {
    const listings = Object.values(state(world).listings)
      .filter(listing => (input.mine ? listing.owner === ctx.memberId : listing.status === 'open' && !isBlockedEitherWay(world, ctx.memberId, listing.owner)))
      .filter(listing => !input.kind || listing.kind === input.kind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
    return { listings: listings.flatMap(listing => listingView(world, ctx.memberId, listing) ?? []) }
  })

  world.register('listing.get', value => ({ listingId: id<ListingId>(obj(value), 'listingId', 'ls') }), (ctx, input) => {
    const listing = state(world).listings[input.listingId]
    if (!listing || !mayRead(world, ctx.memberId, listing)) throw new WorldError('not_found', 'That listing was not found.')
    return { listing: requireFound(listingView(world, ctx.memberId, listing), 'That listing') }
  })

  world.register('listing.save', value => {
    const raw = obj(value)
    return {
      listingId: optId<ListingId>(raw, 'listingId', 'ls'), kind: oneOf(raw, 'kind', ['job', 'task'] as const), title: str(raw, 'title', { min: 3, max: 100 }),
      organisation: str(raw, 'organisation', { max: 80 }), description: str(raw, 'description', { min: 10, max: 2000 }), areaLabel: str(raw, 'areaLabel', { max: 80 }),
      remote: bool(raw, 'remote'), compensation: str(raw, 'compensation', { max: 160 }),
    }
  }, (ctx, input) => {
    const at = iso(ctx.now)
    const { listingId, ...fields } = input
    let listing: ListingRecord
    if (listingId) {
      listing = findListing(world, listingId)
      if (listing.owner !== ctx.memberId) return forbidden('You can only edit your own listings.')
      Object.assign(listing, fields, { updatedAt: at })
    } else {
      world.limit(`listing.save:${ctx.memberId}`, 10, 86_400_000)
      listing = { id: newId<ListingId>('ls'), owner: ctx.memberId, ...fields, status: 'open', createdAt: at, updatedAt: at }
      state(world).listings[listing.id] = listing
    }
    world.touch()
    pushListings(world, ctx.memberId, ...applicationsOf(world, listing.id).map(app => app.applicant))
    return { listing: requireFound(listingView(world, ctx.memberId, listing), 'That listing') }
  })

  world.register('listing.setStatus', value => {
    const raw = obj(value)
    return { listingId: id<ListingId>(raw, 'listingId', 'ls'), status: oneOf(raw, 'status', ['open', 'filled', 'closed'] as const) }
  }, (ctx, input) => {
    const listing = findListing(world, input.listingId)
    if (listing.owner !== ctx.memberId) return forbidden('Only the owner can change a listing’s status.')
    listing.status = input.status
    listing.updatedAt = iso(ctx.now)
    world.touch()
    pushListings(world, ctx.memberId, ...applicationsOf(world, listing.id).map(app => app.applicant))
    return { listing: requireFound(listingView(world, ctx.memberId, listing), 'That listing') }
  })

  // ── Applications ──

  world.register('application.submit', value => {
    const raw = obj(value)
    return { listingId: id<ListingId>(raw, 'listingId', 'ls'), message: str(raw, 'message', { min: 10, max: 1000 }), contact: str(raw, 'contact', { min: 3, max: 120 }) }
  }, (ctx, input) => {
    const listing = state(world).listings[input.listingId]
    // A listing that closed while the member was reading it answers with a clear conflict, not a vanishing act.
    if (!listing || isBlockedEitherWay(world, ctx.memberId, listing.owner)) throw new WorldError('not_found', 'That listing was not found.')
    if (listing.owner === ctx.memberId) return forbidden('You cannot apply to your own listing.')
    if (listing.status !== 'open') throw new WorldError('conflict', `This listing is ${listing.status} and is not taking applications.`)
    const current = mineOn(world, listing.id, ctx.memberId)
    if (current && current.status !== 'withdrawn') throw new WorldError('conflict', 'You have already applied to this listing. Withdraw it first to apply again.')
    world.limit(`application.submit:${ctx.memberId}`, 20, 3_600_000)
    const app: ApplicationRecord = {
      id: newId<ApplicationId>('ap'), listingId: listing.id, applicant: ctx.memberId, message: input.message, contact: input.contact,
      status: 'submitted', createdAt: iso(ctx.now), decidedAt: null,
    }
    state(world).applications[app.id] = app
    world.touch()
    pushListings(world, listing.owner, ctx.memberId)
    emit(world, {
      to: listing.owner, category: 'work', kind: 'application.received', actor: ctx.memberId, link: `/jobs/${listing.id}`, dedupeKey: `application:${listing.id}`,
      title: `New application for ${listing.title}`, body: 'Open the listing to read it and reply.',
    })
    return { application: requireFound(applicationView(world, ctx.memberId, app), 'That application') }
  })

  world.register('application.mine', empty, ctx => ({
    applications: Object.values(state(world).applications).filter(app => app.applicant === ctx.memberId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).flatMap(app => applicationView(world, ctx.memberId, app) ?? []),
  }))

  world.register('application.forListing', value => ({ listingId: id<ListingId>(obj(value), 'listingId', 'ls') }), (ctx, input) => {
    const listing = findListing(world, input.listingId)
    if (listing.owner !== ctx.memberId) return forbidden('Only the listing owner can read its applications.')
    return {
      applications: applicationsOf(world, listing.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).flatMap(app => applicationView(world, ctx.memberId, app) ?? []),
    }
  })

  world.register('application.decide', value => {
    const raw = obj(value)
    return { applicationId: id<ApplicationId>(raw, 'applicationId', 'ap'), status: oneOf(raw, 'status', ['shortlisted', 'accepted', 'declined', 'withdrawn'] as const) }
  }, (ctx, input) => {
    const app = state(world).applications[input.applicationId]
    const listing = app && state(world).listings[app.listingId]
    if (!app || !listing || (app.applicant !== ctx.memberId && listing.owner !== ctx.memberId)) throw new WorldError('not_found', 'That application was not found.')
    const isOwner = listing.owner === ctx.memberId
    // The owner cannot see a blocked applicant's application, so nothing may change before that answer.
    if (isOwner && isBlockedEitherWay(world, listing.owner, app.applicant)) throw new WorldError('not_found', 'That application was not found.')
    if (input.status === 'withdrawn' ? isOwner : !isOwner) return forbidden(isOwner ? 'Only the applicant can withdraw an application.' : 'Only the listing owner can shortlist, accept or decline.')
    if (app.status === 'withdrawn') throw new WorldError('conflict', 'This application was withdrawn.')
    if (app.status === input.status) throw new WorldError('conflict', `This application is already ${app.status}.`)
    if (input.status === 'withdrawn' && app.status === 'declined') throw new WorldError('conflict', 'This application was already declined.')
    app.status = input.status
    app.decidedAt = iso(ctx.now)
    world.touch()
    pushListings(world, listing.owner, app.applicant)
    const to = isOwner ? app.applicant : listing.owner
    emit(world, {
      to, category: 'work', kind: input.status === 'withdrawn' ? 'application.withdrawn' : 'application.decided', actor: ctx.memberId, link: `/jobs/${listing.id}`,
      dedupeKey: isOwner ? `application:${app.id}` : `application:${listing.id}`,
      title: isOwner ? `Your application for ${listing.title} was ${input.status}` : `An application for ${listing.title} was withdrawn`,
      body: isOwner ? 'Open the listing to see the update.' : 'The applicant is no longer interested.',
    })
    return { application: requireFound(applicationView(world, ctx.memberId, app), 'That application') }
  })
}
