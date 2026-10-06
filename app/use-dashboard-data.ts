"use client";

import { useEffect, useState } from "react";
import { fallbackDashboard, loadDashboard } from "../lib/dashboard-source";

export function useDashboardData() {
  const [data, setData] = useState(fallbackDashboard);
  const [status, setStatus] = useState<"loading" | "live" | "unavailable">("loading");
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let version: string | undefined;
    let controller: AbortController | undefined;
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 30_000);
      try {
        const snapshot = await loadDashboard(version, controller.signal);
        if (!stopped) {
          if (snapshot) { version = snapshot.version; setData(snapshot.data); }
          setStatus("live");
        }
      } catch {
        if (!stopped) setStatus("unavailable");
      } finally {
        clearTimeout(timeout);
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5 * 60_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  return { data, status };
}
