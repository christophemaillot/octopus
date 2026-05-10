// Config types — matches Rust OctopusConfig deserialization

export interface OctopusConfig {
  hub: HubConfig;
  agents: AgentConfig[];
}

export interface HubConfig {
  url: string;
  token: string;
}

export interface AgentConfig {
  id: string;
  label: string;
  model: string;
  avatar: string;
}
