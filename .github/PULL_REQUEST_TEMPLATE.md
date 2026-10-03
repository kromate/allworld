## What and why

<!-- One or two sentences. Which area: characters, maps/world, games, social, life/work, travel, market, platform? -->

## Evidence

<!-- Paste the last lines of each. Local results only prove local behaviour. -->

- [ ] `npm run typecheck`
- [ ] `node scripts/check-structure.mjs`
- [ ] Probes for the areas touched (`node scripts/verify-….ts`):
- [ ] For anything visible: looked at 360 px wide and at desktop width, and used by keyboard

Not checked (say so plainly — a real phone, a hosted build, another browser):

## Checklist

- [ ] The service decides anything shared or valuable; the App only asks and shows
- [ ] No photo, face data or precise location is stored, sent or logged beyond what the docs describe
- [ ] No invented members, messages or counts
- [ ] Timers, listeners, workers and three.js resources I created are released
- [ ] No new dependency, test framework, paid service or external host — or it is explained above
- [ ] New or changed assets: source, terms and changes recorded in `docs/ASSETS-LICENSES.md` and the notice beside the asset
- [ ] Shared files (`src/shared/`, service core, shell, build config) are untouched — or this pull request is only that change
- [ ] No home-folder or fixed temporary paths in committed files
