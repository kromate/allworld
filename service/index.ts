// Assemble the world service from its modules.
import { World } from './kernel.ts'
import type { WorldOptions } from './kernel.ts'
import { registerMembers } from './members.ts'
import { registerNotify } from './notify.ts'
import { registerRooms } from './rooms.ts'
import { registerSocial } from './social.ts'
import { registerHomes } from './homes.ts'
import { registerWork } from './work.ts'
import { registerGames } from './games.ts'
import { registerMarket } from './market.ts'
import { registerJobs } from './jobs.ts'
import { registerTravel } from './travel.ts'
import { registerLife } from './life.ts'
import { registerDirect } from './direct.ts'
import { registerComeback } from './comeback.ts'
import { registerArena } from './arena/index.ts'
import { registerStreetEntry } from './streetEntry.ts'
import { registerVehicles } from './vehicles.ts'

export function createWorld(options: WorldOptions = {}): World {
  const world = new World(options)
  registerMembers(world)
  registerNotify(world)
  registerRooms(world)
  registerSocial(world)
  registerHomes(world)
  registerWork(world)
  registerGames(world)
  registerMarket(world)
  registerJobs(world)
  registerTravel(world)
  registerLife(world)
  registerDirect(world)
  registerComeback(world)
  registerArena(world)
  registerVehicles(world)
  registerStreetEntry(world)
  return world
}

export { World } from './kernel.ts'
