import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OctopusConfig } from "../lib/config";

export interface ConfigState {
  config: OctopusConfig | null;
  loading: boolean;
  error: string | null;
  avatarUrl: (agentId: string) => string;
}

export function useConfig(): ConfigState {
  const [config, setConfig] = useState<OctopusConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [avatars, setAvatars] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const cfg = await invoke<OctopusConfig>("read_config");
        setConfig(cfg);

        // Check which avatars exist
        const existing = new Set<string>();
        for (const agent of cfg.agents) {
          const exists = await invoke<boolean>("avatar_exists", {
            agentId: agent.id,
          });
          if (exists) existing.add(agent.id);
        }
        setAvatars(existing);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const avatarUrl = (agentId: string): string => {
    if (avatars.has(agentId)) {
      // Tauri v2 can use `convertFileSrc` or asset protocol for local files
      // For now, return a placeholder that Tauri resolves
      return `asset://localhost/agents/${agentId}/avatar`;
    }
    return "";
  };

  return { config, loading, error, avatarUrl };
}
