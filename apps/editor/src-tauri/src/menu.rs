//! Plan 43: the native menu bar (File, Edit, View, Photo, Window, Help).
//!
//! The webview describes the app's items (`src/lib/nativeMenu.ts`) and installs the menu with `install_native_menu`
//! when the `VITE_PHOTOBOOK_NATIVE_MENU` Vite flag is set; without the flag Tauri's default macOS menu stays and the
//! webview's keydown handlers own every shortcut, as before. Each app item emits one `native-menu` event with its id;
//! the webview runs the same action the key runs today.
//!
//! While a text field has focus (`set_text_focus`), Edit's Undo, Redo, Cut, Copy, Paste and Select all are swapped for
//! the system items (which act on the field's own text), and every other item with an accelerator is disabled, so a
//! key typed into the field is the field's.

use std::collections::HashSet;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{
    AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, State, Wry};

use crate::error::{Error, Result};

/// The event an app item emits, with its id as the payload.
pub const MENU_EVENT: &str = "native-menu";

/// The app's submenus, in menu-bar order (between the app menu and Window).
#[derive(Debug, Deserialize)]
pub struct MenuSpec {
    pub submenus: Vec<SubmenuSpec>,
}

#[derive(Debug, Deserialize)]
pub struct SubmenuSpec {
    pub title: String,
    pub items: Vec<ItemSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ItemSpec {
    Separator,
    #[serde(rename_all = "camelCase")]
    Item {
        id: String,
        label: String,
        /// Tauri accelerator syntax, e.g. `CmdOrCtrl+Shift+Z`.
        accelerator: Option<String>,
        /// The system item that stands in for this one while a text field has focus.
        text_edit: Option<TextEdit>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextEdit {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

/// Where an Edit item sits, for the swap: the submenu index in the spec and the position inside it.
#[derive(Debug, PartialEq, Eq)]
struct SwapSlot {
    submenu: usize,
    position: usize,
    id: String,
    edit: TextEdit,
}

/// What `install_native_menu` builds from a spec: the swaps, the ids of the other keyed items, every app id.
#[derive(Debug)]
struct Layout {
    swaps: Vec<SwapSlot>,
    keyed: Vec<String>,
    ids: HashSet<String>,
}

/// Check the spec (unique, non-empty ids and labels; one item per system edit) and lay it out.
fn layout(spec: &MenuSpec) -> Result<Layout> {
    let mut swaps = Vec::new();
    let mut keyed = Vec::new();
    let mut ids = HashSet::new();
    let mut edits = HashSet::new();
    for (s, submenu) in spec.submenus.iter().enumerate() {
        if submenu.title.trim().is_empty() {
            return Err(Error::Invalid("A menu has no title".into()));
        }
        for (position, item) in submenu.items.iter().enumerate() {
            let ItemSpec::Item { id, label, accelerator, text_edit } = item else { continue };
            if id.is_empty() || label.trim().is_empty() {
                return Err(Error::Invalid(format!("Menu item {id:?} needs an id and a label")));
            }
            if !ids.insert(id.clone()) {
                return Err(Error::Invalid(format!("Menu item {id} is listed twice")));
            }
            match text_edit {
                Some(edit) => {
                    if !edits.insert(*edit) {
                        return Err(Error::Invalid(format!("Two menu items stand for {edit:?}")));
                    }
                    swaps.push(SwapSlot { submenu: s, position, id: id.clone(), edit: *edit });
                }
                None if accelerator.is_some() => keyed.push(id.clone()),
                None => {}
            }
        }
    }
    Ok(Layout { swaps, keyed, ids })
}

struct Swap {
    submenu: Submenu<Wry>,
    position: usize,
    app_item: MenuItem<Wry>,
    system_item: PredefinedMenuItem<Wry>,
}

struct Installed {
    swaps: Vec<Swap>,
    keyed: Vec<MenuItem<Wry>>,
    text_focus: bool,
}

/// The installed menu's swappable parts; empty until the webview installs it.
#[derive(Default)]
pub struct NativeMenu(Mutex<Option<Installed>>);

fn system_item(app: &AppHandle, edit: TextEdit) -> Result<PredefinedMenuItem<Wry>> {
    Ok(match edit {
        TextEdit::Undo => PredefinedMenuItem::undo(app, None)?,
        TextEdit::Redo => PredefinedMenuItem::redo(app, None)?,
        TextEdit::Cut => PredefinedMenuItem::cut(app, None)?,
        TextEdit::Copy => PredefinedMenuItem::copy(app, None)?,
        TextEdit::Paste => PredefinedMenuItem::paste(app, None)?,
        TextEdit::SelectAll => PredefinedMenuItem::select_all(app, None)?,
    })
}

fn build(app: &AppHandle, spec: &MenuSpec, layout: &Layout) -> Result<(Menu<Wry>, Installed)> {
    let name = app.package_info().name.clone();
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let menu = Menu::new(app)?;
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    menu.append(&app_menu)?;

    let mut submenus = Vec::new();
    let mut items = std::collections::HashMap::new();
    for submenu_spec in &spec.submenus {
        let submenu = Submenu::new(app, &submenu_spec.title, true)?;
        for item in &submenu_spec.items {
            match item {
                ItemSpec::Separator => submenu.append(&PredefinedMenuItem::separator(app)?)?,
                ItemSpec::Item { id, label, accelerator, .. } => {
                    let item = MenuItem::with_id(app, id.as_str(), label, true, accelerator.as_deref())?;
                    submenu.append(&item)?;
                    items.insert(id.clone(), item);
                }
            }
        }
        menu.append(&submenu)?;
        submenus.push(submenu);
    }

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    menu.append(&window_menu)?;
    menu.append(&Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?)?;

    let mut swaps = Vec::new();
    for slot in &layout.swaps {
        swaps.push(Swap {
            submenu: submenus[slot.submenu].clone(),
            position: slot.position,
            app_item: items[&slot.id].clone(),
            system_item: system_item(app, slot.edit)?,
        });
    }
    let keyed = layout.keyed.iter().map(|id| items[id].clone()).collect();
    Ok((menu, Installed { swaps, keyed, text_focus: false }))
}

/// Install the menu bar (once; later calls do nothing). Called by the webview when the native-menu flag is on.
#[tauri::command]
pub fn install_native_menu(app: AppHandle, state: State<'_, NativeMenu>, spec: MenuSpec) -> Result<()> {
    let mut slot = state.0.lock().map_err(|_| Error::Invalid("The menu state is unavailable".into()))?;
    if slot.is_some() {
        return Ok(());
    }
    let layout = layout(&spec)?;
    let (menu, installed) = build(&app, &spec, &layout)?;
    app.set_menu(menu)?;
    let ids = layout.ids;
    app.on_menu_event(move |app, event| {
        let id = event.id().as_ref();
        // The system items (Quit, Copy in a text field, ...) act on their own.
        if ids.contains(id) {
            let _ = app.emit(MENU_EVENT, id);
        }
    });
    *slot = Some(installed);
    Ok(())
}

/// The webview's text focus: a text field took focus (`true`) or the last one lost it (`false`). A no-op until the
/// menu is installed.
#[tauri::command]
pub fn set_text_focus(state: State<'_, NativeMenu>, focused: bool) -> Result<()> {
    let mut slot = state.0.lock().map_err(|_| Error::Invalid("The menu state is unavailable".into()))?;
    let Some(installed) = slot.as_mut() else { return Ok(()) };
    if installed.text_focus == focused {
        return Ok(());
    }
    for swap in &installed.swaps {
        if focused {
            swap.submenu.remove(&swap.app_item)?;
            swap.submenu.insert(&swap.system_item, swap.position)?;
        } else {
            swap.submenu.remove(&swap.system_item)?;
            swap.submenu.insert(&swap.app_item, swap.position)?;
        }
    }
    for item in &installed.keyed {
        item.set_enabled(!focused)?;
    }
    installed.text_focus = focused;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(json: serde_json::Value) -> MenuSpec {
        serde_json::from_value(json).expect("spec parses")
    }

    #[test]
    fn lays_out_swaps_and_keyed_items() {
        let spec = spec(serde_json::json!({ "submenus": [
            { "title": "File", "items": [
                { "kind": "item", "id": "file.export", "label": "Export…", "accelerator": "CmdOrCtrl+Shift+E" },
                { "kind": "item", "id": "file.saveAs", "label": "Save as…" },
            ]},
            { "title": "Edit", "items": [
                { "kind": "item", "id": "edit.undo", "label": "Undo", "accelerator": "CmdOrCtrl+Z",
                  "textEdit": "undo" },
                { "kind": "separator" },
                { "kind": "item", "id": "edit.selectAll", "label": "Select all", "accelerator": "CmdOrCtrl+A",
                  "textEdit": "selectAll" },
            ]},
        ]}));
        let layout = layout(&spec).expect("valid");
        assert_eq!(
            layout.swaps,
            vec![
                SwapSlot { submenu: 1, position: 0, id: "edit.undo".into(), edit: TextEdit::Undo },
                SwapSlot { submenu: 1, position: 2, id: "edit.selectAll".into(), edit: TextEdit::SelectAll },
            ]
        );
        // Save as has no accelerator, so it stays on while a text field has focus.
        assert_eq!(layout.keyed, vec!["file.export".to_string()]);
        assert_eq!(layout.ids.len(), 4);
    }

    #[test]
    fn refuses_duplicates() {
        let twice = spec(serde_json::json!({ "submenus": [{ "title": "Photo", "items": [
            { "kind": "item", "id": "photo.pick", "label": "Pick" },
            { "kind": "item", "id": "photo.pick", "label": "Pick again" },
        ]}]}));
        assert!(layout(&twice).is_err());
        let two_undos = spec(serde_json::json!({ "submenus": [{ "title": "Edit", "items": [
            { "kind": "item", "id": "a", "label": "Undo", "textEdit": "undo" },
            { "kind": "item", "id": "b", "label": "Undo too", "textEdit": "undo" },
        ]}]}));
        assert!(layout(&two_undos).is_err());
        let unnamed = spec(serde_json::json!({ "submenus": [{ "title": "View", "items": [
            { "kind": "item", "id": "", "label": "Nothing" },
        ]}]}));
        assert!(layout(&unnamed).is_err());
    }
}
