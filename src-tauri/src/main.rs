#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use tauri::{Emitter, Manager};

fn is_doc(a: &str) -> bool {
    let l = a.to_lowercase();
    (l.ends_with(".pdf") || l.ends_with(".docx")) && Path::new(a).is_file()
}

/// Every command-line argument that is an existing .pdf or .docx (used for "Open with" / double-click).
#[tauri::command]
fn initial_files() -> Vec<String> {
    std::env::args().skip(1).filter(|a| is_doc(a)).collect()
}

/// "Download" = save a copy of the opened file elsewhere.
#[tauri::command]
fn save_copy(src: String, dst: String) -> Result<(), String> {
    std::fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        // Must be registered first: a second launch (e.g. double-clicking another PDF)
        // hands its files to the running window, which opens them as new tabs.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            for a in args.iter().skip(1).filter(|a| is_doc(a)) {
                let _ = app.emit("open-file", a.clone());
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![initial_files, save_copy])
        .run(tauri::generate_context!())
        .expect("error while running PDF Reader");
}
