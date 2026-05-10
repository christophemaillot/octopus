import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Thread } from "../lib/types";

// Auto-save threads to disk via Tauri backend.
// Threads are saved as JSON files in ~/.config/octopus/sessions/

export function usePersistence(
  threads: Record<string, Thread[]>,
  setThreads: React.Dispatch<React.SetStateAction<Record<string, Thread[]>>>,
) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef("");
  const loadedRef = useRef(false);

  // Auto-save with debounce (2s after last change)
  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(() => {
      const json = JSON.stringify(threads);
      if (json === lastSavedRef.current) return; // skip if unchanged
      lastSavedRef.current = json;

      invoke("save_threads", { data: json }).catch((e) =>
        console.error("Failed to save threads:", e),
      );
    }, 2000);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [threads]);

  // Load threads from disk
  const loadThreads = useCallback((): Record<string, Thread[]> | null => {
    // Use synchronous-like approach via invoke
    // We return null initially if not loaded yet
    return null;
  }, []);

  // Async load on mount
  useEffect(() => {
    (async () => {
      try {
        const raw: string | null = await invoke("load_threads");
        if (raw) {
          const data = JSON.parse(raw) as Record<string, Thread[]>;
          setThreads(data);
          lastSavedRef.current = raw;
        }
      } catch (e) {
        console.warn("No saved threads found:", e);
      }
      loadedRef.current = true;
    })();
  }, [setThreads]);

  return { loadThreads };
}
