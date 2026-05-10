// Octopus Desktop — lib Tauri

mod config;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! From Octopus Desktop.", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            greet,
            config::read_config,
            config::avatar_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
