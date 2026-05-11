// Octopus Desktop — config reader
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OctopusConfig {
    #[serde(default)]
    pub hub: HubConfig,
    #[serde(default)]
    pub agents: Vec<AgentConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HubConfig {
    #[serde(default = "default_hub_url")]
    pub url: String,
    #[serde(default)]
    pub token: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentConfig {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub avatar: String,
}

fn default_hub_url() -> String {
    "wss://octopus.chrm.fr".to_string()
}

fn default_model() -> String {
    "deepseek/deepseek-v4-flash".to_string()
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            url: default_hub_url(),
            token: String::new(),
        }
    }
}

impl Default for OctopusConfig {
    fn default() -> Self {
        Self {
            hub: HubConfig::default(),
            agents: vec![
                AgentConfig {
                    id: "basile".into(),
                    label: "Basile".into(),
                    model: default_model(),
                    avatar: String::new(),
                },
                AgentConfig {
                    id: "kip".into(),
                    label: "Kip".into(),
                    model: "anthropic/claude-sonnet-4-6".into(),
                    avatar: String::new(),
                },
            ],
        }
    }
}

/// Use $HOME/.config/octopus/ on all platforms
pub fn config_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE")) // Windows fallback
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".config").join("octopus")
}

pub fn config_path() -> PathBuf {
    config_dir().join("octopus.toml")
}

pub fn avatar_path(agent_id: &str) -> PathBuf {
    config_dir().join("avatars").join(format!("{}.png", agent_id))
}

#[tauri::command]
pub fn read_config() -> OctopusConfig {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => match toml::from_str(&content) {
            Ok(cfg) => cfg,
            Err(e) => {
                eprintln!("octopus: failed to parse config: {e}");
                OctopusConfig::default()
            }
        },
        Err(_) => {
            eprintln!("octopus: no config at {:?}, using defaults", path);
            OctopusConfig::default()
        }
    }
}

#[tauri::command]
pub fn avatar_exists(agent_id: String) -> bool {
    avatar_path(&agent_id).exists()
}

// ── Session persistence ─────────────────────────────────────────────────

fn sessions_dir() -> PathBuf {
    config_dir().join("sessions")
}

#[tauri::command]
pub fn save_threads(data: String) -> Result<(), String> {
    let dir = sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let path = dir.join("threads.json");
    fs::write(&path, &data).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_threads() -> Result<Option<String>, String> {
    let path = sessions_dir().join("threads.json");
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn save_replay_state(data: String) -> Result<(), String> {
    let dir = sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let path = dir.join("replay-state.json");
    fs::write(&path, &data).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_replay_state() -> Result<Option<String>, String> {
    let path = sessions_dir().join("replay-state.json");
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(_) => Ok(None),
    }
}
