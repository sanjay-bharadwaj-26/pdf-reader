#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;

/// First command-line argument that is an existing .pdf (used for "Open with" / double-click).
#[tauri::command]
fn initial_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| a.to_lowercase().ends_with(".pdf") && Path::new(a).is_file())
}

/// "Download" = save a copy of the opened file elsewhere.
#[tauri::command]
fn save_copy(src: String, dst: String) -> Result<(), String> {
    std::fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![initial_file, save_copy])
        .run(tauri::generate_context!())
        .expect("error while running PDF Reader");
}
