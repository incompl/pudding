use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const KEY_LIBRARY_ROOT: &str = "libraryRoot";

#[derive(Serialize)]
struct DirListing {
    folders: Vec<String>,
    files: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Stream {
    name: String,
    url: String,
}

#[tauri::command]
fn list_dir(path: String) -> Result<DirListing, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;

    let mut folders = Vec::new();
    let mut files = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();

        if file_type.is_dir() {
            folders.push(name);
        } else if file_type.is_file() && name.to_lowercase().ends_with(".mp3") {
            files.push(name);
        }
    }

    folders.sort_by_key(|s| s.to_lowercase());
    files.sort_by_key(|s| s.to_lowercase());

    Ok(DirListing { folders, files })
}

#[tauri::command]
fn read_manifest(path: String) -> Result<Vec<Stream>, String> {
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&contents).map_err(|e| e.to_string())
}

// Asset scope is in-memory only. Re-applied on boot from the store, and
// extended at runtime when the user changes the library root.
#[tauri::command]
fn set_asset_scope(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let store = app.store(STORE_FILE)?;
            if let Some(value) = store.get(KEY_LIBRARY_ROOT) {
                if let Some(path) = value.as_str() {
                    if !path.is_empty() {
                        app.asset_protocol_scope().allow_directory(path, true)?;
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_manifest,
            set_asset_scope
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
