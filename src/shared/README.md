# The contract

Everything the App and the service must agree on. Both import these files, and so does every
probe, so a mismatch is a type error rather than a bug found later.

| File | Holds |
| --- | --- |
| `ids.ts` | Branded id types, new ids, ISO timestamps |
| `model.ts` | Members, looks, faces, areas, rooms, chat, errors |
| `protocol.ts` | Every operation by name with its input and output, and the events the service pushes |
| `geo.ts` | Coordinates, districts, coarse areas |
| `appearance.ts` | Character appearance and how it is validated |
| `social.ts`, `direct.ts`, `notify.ts`, `comeback.ts` | Friends, communities, homes; messages; notifications; come-back messages |
| `life.ts`, `play.ts`, `travel.ts`, `market.ts` | Needs and meals; work and table games; fares and documents; products and jobs |
| `arena.ts`, `games/` | The game hall, and one rules file per game |

## Rules for this folder

- **It imports nothing but itself** (and `src/brand.ts`). No Vue, no three.js, no Node, no
  packages, nothing from `src/features/` or `service/`. `node scripts/check-structure.mjs` checks this.
- **Types and pure functions only.** A function here takes values and returns values: no
  storage, no network, and no clock or randomness except through its arguments. That is what lets
  the service, the browser and a probe get the same answer. The two present exceptions are id
  creation in `ids.ts` and the time guard on the chess computer's search.
- **A rule lives here when both sides need it.** A fare the App previews and the service charges
  is one function. A rule only the service applies stays in `service/`.
- **Add, do not alter.** A new optional field or a new operation is safe. Renaming or removing
  breaks saved worlds and other people's work in progress; propose it first.
- **Ship it with its user.** A new operation arrives with its service handler and a probe check,
  not ahead of them.

This folder belongs to the maintainers: see `CONTRIBUTING.md`, "Shared files".
