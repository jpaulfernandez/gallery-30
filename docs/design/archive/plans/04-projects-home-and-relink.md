# 04 · Projects in app data, Home, relink by hash

Status: done 2026-10-12, with three deviations. The New project dialog picks one folder and has no *what to add*
choice: until plan 05's Project and Library tabs the filmstrip is the project's (primary) folder and every photo in it
joins the project as it is hashed, so *picks only* and *nothing* would have nothing to act on; projects span folders
through relink (a photo found in another imported folder adds that folder). `create_project` takes `(id, json)` built
with `createEmptyBook` (the Zod schema stays the only definition) and checks in Rust that every folder is imported.
Save as and Open project file were verified by Rust tests on the store, not in the app (the native dialogs cannot be
driven from the agent shell). Pruning full renders after a publish only touches renders of the project's own photos and
keeps both output profiles of their current settings; a render of the same photo that another project needs for a
different edit (a develop snapshot or version, from plan 08) can still be pruned and is re-rendered before that
project's next publish. Closed for versions by plan 08: every edit the folder library holds (master and versions) is
kept; only another project's develop snapshot can still be pruned.

WORKFLOW_PLAN [14](../WORKFLOW_PLAN.md#14-the-three-layers), [14.6](../WORKFLOW_PLAN.md#146-migration-from-todays-files).
Size: 2 days. Depends on: 03.

**Goal.** A project is a file in app data (or anywhere via Save as), Home lists projects and folders, a legacy
`book.photobook.json` is imported once, and a photo that moved between imported folders relinks by hash.

## Decisions

- `<appdata>/projects/<ULID>/project.photobook.json`; the directory listing is the registry. Projects saved elsewhere
  are remembered in `<appdata>/projects.json` as `{ id, path }`. `recent.json` becomes `{ project: id }`.
- Legacy import: a `<folder>/book.photobook.json` found when a folder is imported (01) or at startup for registry
  folders becomes a project in app data; the old file is renamed `book.photobook.json.imported`. Never twice.
- Delete project = move the project directory to the Trash (`tauri-plugin-opener` or `trash` crate), after confirm.

## Steps

1. **Rust.** `commands/book.rs` → `commands/projects.rs`: `list_projects` (id, title, folders, updatedAt, cover asset
   hash for a thumbnail), `create_project(title, folderIds)`, `read_project(id)`, `write_project(id, json)` (temp +
   rename + `.bak`), `delete_project(id)`, `save_project_as(id, path)`, `open_project_file(path)` (dialog-picked),
   `import_legacy_book(folderId)`. `get_recent`/`set_recent` keyed by project id. `ensure_allowed` already covers
   app data; external paths are allowed when dialog-picked or listed in `projects.json`.
2. **TS.** `lib/tauri.ts` wrappers; `store/book.ts`: `loadProject(id)`, `createProject`, `saveAs`, `close`;
   `loadFromFolder` becomes "import folder, import legacy book, open it".
3. **Router.** `/book` → `/project/$id`, `/book/preview` → `/project/$id/preview`, `/book/downloads` →
   `/project/$id/downloads`; the launch loader reopens the recent project. `requireBook` → `requireProject`.
4. **Home.** `routes/home.tsx`: Projects (cover, title, folder names, last opened; Open, Rename, Delete, Reveal) and
   Folders (01). **New project…** dialog: title, template, folder(s) from the registry or Import folder…, and what to
   add: *all photos*, *picks only*, *nothing*. **Open project file…** for projects saved elsewhere.
5. **Relink.** `store/relink.ts`: an asset whose `folders[asset.folder].path + asset.path` is missing is searched
   by size then hash across every imported folder's scan (05 adds a persisted index; until then the live scan);
   on a hit `folder` and `path` are rewritten, the id kept. Missing cell and Locate stay for misses.
6. **Autosave and publish.** `autosave.ts` writes through `write_project`; `publishRunner.ts` passes the project
   path to the CLI (`photobook publish <path>` unchanged for the user).

## Check

- Two projects on one folder open and save independently; an edit made in one shows in the other after reopen.
- A folder with a legacy `book.photobook.json` imports exactly one project; the `.imported` file is left behind.
- Move a photo to another imported folder: the project relinks it (log line), the canvas renders, the id is unchanged.
- `--dry-run` on both projects; editor Vitest for the store; `cargo test`.

## Docs

- `README.md` (projects, folders), `docs/PUBLISHING.md` (project file location, `Save as`), `docs/INSTALLATION.md`,
  `CLAUDE.md` Layout and caches (`<appdata>/projects/`).

## Out of scope

Sidebar and stages (05), output documents (13).
