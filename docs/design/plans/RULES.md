# Working rules for plans 38–56

Oct 13, 2026. Handed to every agent that runs a plan of
[IMPLEMENTATION_PLAN_38-56.md](IMPLEMENTATION_PLAN_38-56.md) (section 5). The plan cards (section 6) say what each
plan owns; the source documents (CULL_PLAN, ODDHALLS_UI_PLAN, ODDHALLS_LAYOUT_PLAN) hold the steps and the Check list.

1. Never run `git stash`, `checkout`, `reset`, `clean` or `commit`; the user commits. Never `pnpm dev` or `tauri dev`
   while another agent runs; verify in a browser through `editor-web` (Vite only, port 1420) or with tests.
2. Edit only the files your plan owns (section 6); in a shared file make additive edits, re-read it before each
   edit, and never reformat beyond your change. Biome runs with explicit paths (`pnpm biome check --write <paths>`).
3. `cargo test -p photobook-develop --lib` or `--test <name>`, and `cargo test --lib` in `src-tauri`, never the
   whole workspace; never build a scratch copy of the tree; `target/` is shared, so do not delete it. Cargo is not on
   PATH: prefix every cargo command with `source ~/.cargo/env &&`.
4. No engine bump outside 55; no `UPDATE_*_FIXTURES` outside 55; never change `identifier` in `tauri.conf.json`.
5. New colour, radius, shadow or duration only through the tokens (44+); new controls only from `components/ui`
   (45+); `pnpm lint` includes the palette script and must pass before the Status line is written.
6. Ratings, flags and cull decisions are not undo steps (plans 02/06); Decide has its own log (40). Do not add them
   to the undo stack.
7. Every Rust writer in a job writes a temp file and renames it; `trash_photos` refuses any path that is not under
   an imported root.
8. Finish by writing the plan file's Status line (what landed, deviations, what was not verified) and the dated line
   in DESIGN_NOTES the plan names; nothing is done without it.

Plan files: at the start of its session the implementer creates `docs/design/plans/NN-<slug>.md` from the source
section (copied verbatim, the heading in the archived plans' form, a *Depends on* line from section 2, and the
*Status:* line added when done). Names are listed in section 3 of the implementation plan.
