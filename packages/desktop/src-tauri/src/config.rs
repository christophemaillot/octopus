// Octopus Desktop — config reader
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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

pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("octopus")
        .join("octopus.toml")
}

pub fn avatar_path(agent_id: &str) -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("octopus")
        .join("avatars")
        .join(format!("{}.png", agent_id))
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
