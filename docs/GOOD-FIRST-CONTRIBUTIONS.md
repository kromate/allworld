# Good first contributions

Choose one bounded task. Check its entry points in [CONTRIBUTOR-MAP.md](CONTRIBUTOR-MAP.md),
then follow [CONTRIBUTING.md](../CONTRIBUTING.md). These are contribution proposals, not
published issues or promises of assigned work.

| Task | Files to start with | Acceptance | Boundary |
| --- | --- | --- | --- |
| Correct avatar error or recovery copy | `src/features/avatar/FaceCapture.vue`, `AvatarPreview.vue` | The failing step names the problem and offers a working recovery. Check no-face, cancelled capture, unavailable camera, and failed preview at 360 px and by keyboard | Keep match choices editable. Never upload a fixture photo, save guest photo pixels, or add a generation provider |
| Make one map control usable by keyboard | `src/features/map/`, `src/features/travel/` | The control has a name, visible focus, and a non-pointer action. Map attribution stays visible at 360 px | Keep provider URLs and map attribution. Do not add autocomplete requests or infer the player's actual position |
| Improve one existing regional prop | `src/world/regions/`, `scripts/regions/`, `public/regions/LICENSE.md` | Show before and after in the scene. Keep collision handoff, resource disposal, and device budgets. Rebuild the affected pack and manifest, then pass `npm run check:assets` | Start with project-authored geometry. New assets require their exact source and licence |
| Improve a vehicle control label or disabled explanation | `src/features/transport/` in the integrated driving track | Loading, incompatible scene, seated passenger, and disconnected states have accurate text. Verify keyboard and 360 px. A passenger gets no enabled driving action | Use the integrated runtime 089 files. Never change fare, seat, revision, route, or collision authority as a copy fix |
| Improve a home purchase review label | the isolated expanded-home 091 track | The displayed items, total, storage moves, and unknown-outcome state match the service answer. No charge occurs while only reviewing | Wait until candidate 091 is reviewed and integrated. Preserve request IDs, quote expiry, service prices, and physical entry guards |
| Improve a game how-to or keyboard hint | `src/features/arena/games/<game>/HowTo.vue`, the existing board | The described move agrees with the shared rules. The action can be performed without dragging. Run `npm run verify:games` for a rule-dependent change | Rules and outcomes remain in `src/shared/games/` and the service. Do not reveal a player's hidden information |
| Fix an empty, loading, or retry state in one window | The chosen `src/features/<area>/` folder, `src/ui/StateView.vue` | Check empty, pending, refused, offline, and recovered states. No stale success appears after actor change. All actions fit at 360 px | Avoid shell-wide CSS and session changes in the same patch |
| Document one portable probe | `scripts/README.md` and an existing `scripts/verify-*.ts` | The documented command exists, runs with declared dependencies, and states whether it needs network access or writes files | Do not introduce a test framework, new dependencies, secrets, or machine-specific paths |

Server authority, identity exchange, personal-data persistence, durable money acknowledgements,
host admission, and cross-domain contracts need a maintainer review before implementation.
They are valuable contributions, but they are not small first tasks.

Report the actual command outputs and visible checks. Name anything you did not exercise,
including hosted behavior and physical phones. Do not substitute a new recorded debt for a
failing structure check.
