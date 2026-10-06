mod commands;
mod error;
mod scope;

use scope::SourceScope;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    // Debug builds log to stdout so `tauri dev` shows webview `devLog` lines (src/lib/log.ts)
    // next to Rust output. Release builds do not register the plugin; devLog swallows the error.
    #[cfg(debug_assertions)]
    {
        use tauri_plugin_log::{Target, TargetKind};
        builder = builder.plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(Target::new(TargetKind::Stdout))
                .level(log::LevelFilter::Info)
                // Keep third-party crates quiet; the webview and this crate log at info.
                .level_for("tao", log::LevelFilter::Warn)
                .level_for("wry", log::LevelFilter::Warn)
                .level_for("tracing", log::LevelFilter::Warn)
                .build(),
        );
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SourceScope::default())
        .manage(commands::assets::AssetJobs::default())
        .manage(commands::publish::PublishJobs::default())
        // Register every command here. Each one lives in src/commands/<area>.rs.
        .invoke_handler(tauri::generate_handler![
            commands::book::open_book,
            commands::book::write_book,
            commands::book::get_recent,
            commands::book::set_recent,
            commands::assets::scan_folder,
            commands::assets::hash_files,
            commands::assets::prepare_asset,
            commands::assets::read_cache_dir,
            commands::publish::read_publish_settings,
            commands::publish::write_publish_settings,
            commands::publish::run_publish,
            commands::publish::cancel_publish,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Photobook editor");
}
