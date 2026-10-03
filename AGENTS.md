# For coding agents

You are working in a Vue 3 + TypeScript + three.js App with its own world service. These notes
apply to any agent, from any vendor, on any machine. A person's instructions in the conversation
come first; [CONTRIBUTING.md](CONTRIBUTING.md) applies to you as it does to anyone.

## Read first

1. [README.md](README.md) — set-up, checks, what works.
2. [docs/CONTRIBUTOR-MAP.md](docs/CONTRIBUTOR-MAP.md) — find the row for your task; it lists the
   files and the probe.
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the five dependency rules.
4. The README in the folder you are changing, if there is one.

The reports under `docs/` (ledger, tracker, handover, playtests) are history. Read one when your
task needs it, not by default.

## Commands

```sh
npm install
npm run typecheck                    # must stay clean
node scripts/check-structure.mjs     # must stay clean; do not add a debt entry to make it pass
node scripts/verify-<area>.ts        # the probe for what you changed
npm run verify                       # all nine before you hand over
```

To look at the App, run `npm run dev` and open the URL Vite prints with `?as=a`. If a person is using that
server, run your own copy on another port with its own state. See the README for setup.
Never point two servers at one state file.

## Working rules

- Find callers before you change a function, and say what you found. Ground claims in imports,
  not in folder names.
- The service is the authority for anything shared or valuable. A rule both sides need goes in
  `src/shared/`, which imports nothing but itself.
- `src/` never imports `service/` or Node built-ins. `src/world/` and `src/geo/` never import a
  window from `src/features/`.
- Make the smallest change that does the job. No new dependency, test framework, path alias,
  index file or wrapper module unless asked.
- Release every timer, listener, worker and three.js resource you create.
- Windows work at 360 px wide and by keyboard.
- Prove behaviour with a probe in the existing style, or by extending one. Report its output.
- Report plainly: what you changed, what you ran, what passed, what you did not check. Local
  results are not hosted results; an emulated phone is not a phone.

## Do not

- Read, print or commit `.env` files, the saved world in `.goalmatic/local/`, or anyone's photographs.
- Add a photo, face crop or render of a real person anywhere in the tree.
- Invent members, messages, counts, reviews, licences, sources or contact details.
- Call a paid service, add an API key, or send a real email, message or push.
- Add a third-party asset without its source and terms recorded
  ([docs/ASSETS-LICENSES.md](docs/ASSETS-LICENSES.md)), or remove an existing notice.
- Write a home folder or a fixed temporary folder into a file. Take paths from arguments or
  from the script's own location.
- Edit the shared files listed in CONTRIBUTING.md as a side effect of another task. Propose it.
- Commit, push, publish or open a pull request unless the person you are working for asked.

If several agents share the tree, each keeps to its own files, and one writer at a time touches a
shared file.
