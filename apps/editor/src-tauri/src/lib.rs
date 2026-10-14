mod ai;
mod atomic;
mod commands;
mod error;
// Plan 43: the native menu bar, behind the VITE_PHOTOBOOK_NATIVE_MENU flag (installed by the webview).
mod menu;
mod scope;

use scope::ImportedRoots;

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
    // Workflow plan 36: the raw RGBA preview experiment (`commands/raw_preview.rs`), debug builds only; the webview
    // uses it only when `localStorage['photobook.rawPreview']` is `1`.
    #[cfg(debug_assertions)]
    {
        builder = builder
            .register_asynchronous_uri_scheme_protocol(commands::raw_preview::SCHEME, commands::raw_preview::handle);
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(ImportedRoots::default())
        .manage(commands::folders::FolderRegistry::default())
        .manage(commands::assets::AssetJobs::default())
        .manage(commands::publish::PublishJobs::default())
        // Workflow plan 14: social post frame renders (the CLI's `render-frames`), several at once.
        .manage(commands::social::SocialJobs::default())
        // Workflow plan 15: print PDFs (the CLI's `print`).
        .manage(commands::print::PrintJobs::default())
        // Workflow plan 16: slideshow frames (the CLI's `render-slideshow`) and FFmpeg encodes; tool downloads.
        .manage(commands::video::VideoJobs::default())
        .manage(commands::tools::ToolJobs::default())
        .manage(commands::develop::DevelopJobs::default())
        .manage(commands::models::ModelJobs::default())
        .manage(commands::develop::GeometryAnalyses::default())
        .manage(commands::develop::AiMaskState::default())
        .manage(commands::develop::DenoiseState::default())
        // Workflow plan 32: running AI requests, for `ai_cancel`.
        .manage(commands::ai::AiJobs::default())
        // Plan 43: the native menu's swappable items, empty until the webview installs it.
        .manage(menu::NativeMenu::default())
        .setup(|app| {
            // Imported folders become roots before the webview asks for anything (thumbnails, projects), then the
            // legacy book.photobook.json in each becomes a project in app data (workflow plan 04).
            commands::folders::init(app.handle());
            commands::projects::init(app.handle());
            commands::develop::init_gpu(app.handle());
            // Workflow plan 18: renders read user LUTs from <appdata>/luts.
            commands::luts::init(app.handle());
            Ok(())
        })
        // Register every command here. Each one lives in src/commands/<area>.rs.
        .invoke_handler(tauri::generate_handler![
            commands::projects::list_projects,
            commands::projects::create_project,
            commands::projects::read_project,
            commands::projects::write_project,
            commands::projects::delete_project,
            commands::projects::save_project_as,
            commands::projects::open_project_file,
            commands::projects::import_legacy_book,
            commands::projects::get_recent,
            commands::projects::set_recent,
            commands::projects::reveal_project,
            commands::folders::list_folders,
            commands::folders::import_folder,
            commands::folders::remove_folder,
            commands::folders::rename_folder,
            commands::folders::read_index,
            commands::folders::write_index,
            commands::collections::read_collections,
            commands::collections::write_collections,
            commands::library::read_library,
            commands::library::read_library_backup,
            commands::library::write_library,
            commands::assets::scan_folder,
            commands::assets::hash_files,
            commands::assets::prepare_asset,
            commands::assets::read_cache_dir,
            commands::develop::render_develop_preview,
            commands::develop::render_develop_cached,
            commands::develop::develop_sharpen_mask,
            commands::develop::render_develop_full,
            commands::develop::cancel_develop,
            commands::develop::develop_renders_present,
            commands::develop::prune_develop_renders,
            commands::develop::solve_upright_guides,
            commands::develop::analyse_geometry,
            commands::develop::develop_mask_overlay,
            commands::develop::generate_ai_mask,
            commands::develop::sam_refine_mask,
            commands::develop::ai_mask_status,
            commands::develop::release_ai_masks,
            commands::develop::denoise_status,
            commands::develop::run_denoise,
            commands::develop::cancel_denoise,
            commands::develop::preview_denoise_crop,
            commands::develop::looks::render_look_thumbs,
            commands::develop::histogram::histogram,
            commands::publish::read_publish_settings,
            commands::publish::write_publish_settings,
            commands::publish::run_publish,
            commands::publish::cancel_publish,
            commands::social::run_render_frames,
            commands::social::cancel_render_frames,
            commands::print::run_print,
            commands::print::cancel_print,
            commands::print::print_target_exists,
            // Workflow plan 16: slideshow video (src/commands/video.rs) and Settings → Tools (src/commands/tools.rs).
            commands::video::run_slideshow_frames,
            commands::video::encode_slideshow,
            commands::video::cancel_video,
            commands::video::discard_slideshow_frames,
            commands::video::slideshow_preflight,
            commands::video::video_target_exists,
            commands::video::import_audio,
            commands::tools::tool_status,
            commands::tools::download_tool,
            commands::tools::cancel_tool_download,
            commands::tools::delete_tool,
            commands::tools::check_tool,
            commands::models::list_models,
            commands::models::models_dir,
            commands::models::download_model,
            commands::models::cancel_model_download,
            commands::models::delete_model,
            commands::models::open_model_link,
            commands::xmp::read_xmp,
            commands::xmp::write_xmp_sidecar,
            commands::presets::list_presets,
            commands::presets::save_preset,
            commands::presets::delete_preset,
            // Workflow plan 23: noise profiles (src/commands/noise.rs).
            commands::noise::noise_profile,
            commands::noise::camera_profile,
            commands::noise::learn_profile,
            // Workflow plan 11: export from Develop (src/commands/export.rs).
            commands::export::export_photo,
            commands::export::export_status,
            commands::export::check_export_dest,
            commands::export::reveal_export,
            commands::assets::open_map,
            commands::export::list_export_presets,
            commands::export::save_export_preset,
            commands::export::delete_export_preset,
            commands::export::export_capabilities,
            commands::export::import_watermark,
            // Workflow plan 32: Settings → AI and the Anthropic Messages API (src/commands/ai.rs, src/ai/).
            commands::ai::read_ai_settings,
            commands::ai::write_ai_settings,
            commands::ai::ai_test,
            commands::ai::ai_count_tokens,
            commands::ai::ai_describe,
            commands::ai::ai_caption,
            commands::ai::ai_cancel,
            // Workflow plan 34: Exif capture time and GPS for the caption brief's pre-fill.
            commands::ai::photo_capture_info,
            // Workflow plan 18: user 3D LUTs in <appdata>/luts (src/commands/luts.rs).
            commands::luts::import_lut,
            commands::luts::list_luts,
            commands::luts::delete_lut,
            commands::luts::lut_present,
            // Workflow plan 22: Match camera JPEG (src/commands/luts.rs).
            commands::luts::fit_lut,
            commands::luts::film_simulation,
            // Plan 43: the native menu bar and the text focus it follows (src/menu.rs).
            menu::install_native_menu,
            menu::set_text_focus,
            // Plan 46: the haptic tick (src/commands/haptic.rs).
            commands::haptic::haptic,
            // Plan 42: rejects to the Trash (src/commands/photos.rs).
            commands::photos::trash_photos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Photobook editor");
}
