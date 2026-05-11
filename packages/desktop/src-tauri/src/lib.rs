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
            config::save_threads,
            config::load_threads,
            config::save_replay_state,
            config::load_replay_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
