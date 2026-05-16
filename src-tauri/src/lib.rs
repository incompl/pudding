use serde::Serialize;
use tauri::Manager;

// Phase 1: hardcoded library root. Replaced by config in phase 3.
const HARDCODED_LIBRARY_ROOT: &str = "/Users/greg/Library/CloudStorage/ProtonDrive-gsmith@incompl.com-folder/mp3s";

#[derive(Serialize)]
struct DirListing {
    folders: Vec<String>,
    files: Vec<String>,
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
fn get_library_root() -> String {
    HARDCODED_LIBRARY_ROOT.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            app.asset_protocol_scope()
                .allow_directory(HARDCODED_LIBRARY_ROOT, true)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_dir, get_library_root])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
