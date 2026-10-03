# Current source boundary

Allworld's standalone launch, build `allworld-standalone-140`, is live at
https://allworld.akpananthony33.workers.dev/. Public-browser acceptance on 3 October 2026
covered guest entry, account registration and guest claim, sign-in and return, saved progress,
two-player chat and a complete Ten Walls game, work, homes, vehicle boarding and driver
handover, reconnect, and interrupted booking/refund recovery. Mobile controls were checked
in browser viewports; physical-phone and microphone behavior remain unverified.

The initial public source includes that launch foundation plus three locally verified changes:
a stale-rematch-response guard, body-texture skin-edge coverage, and smooth cue-bus gain
changes. Source publication does not deploy these additions to the live game. The export
manifest records the exact selected source and asset hashes.

The current free-host configuration admits four simultaneous player connections. Each tab
uses a connection, and provider daily quotas can interrupt service. Large-scale concurrency
has not been demonstrated. Direct vehicle-click boarding and smoother networked driving
are active follow-up work. The existing service controls seats, movement and game coins.

Face/body cloning is unfinished. The active photo path uses front landmarks and an optional
photo projection on a stock head. The experimental GNM fitting path is not connected to the
player workflow. No personal-likeness percentage or complete body reconstruction is claimed.

Original code is Apache-2.0. Bundled models, textures, dictionaries and map-derived data keep
their own grants and notices. OpenStreetMap-derived transport and home data remain ODbL.
The public source excludes private photographs, saved worlds, credentials, operational logs,
handover histories and owner-specific fits.

Use [CONTRIBUTOR-MAP.md](CONTRIBUTOR-MAP.md) to find ownership and probes,
[HOSTING.md](HOSTING.md) for runtime boundaries, and [SOURCE-EXPORT.md](SOURCE-EXPORT.md)
for the reviewed export procedure. Local checks, source publication, provider deployment
and browser acceptance are separate results.
