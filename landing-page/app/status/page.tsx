"use client"

import { useEffect, useState } from "react"
import { emptyPublicStats, fetchPublicStats, type PublicStats } from "@/lib/public-stats"

export default function StatusPage() {
  const [stats, setStats] = useState<PublicStats>(emptyPublicStats)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const next = await fetchPublicStats()
        if (!cancelled) {
          setStats(next)
          setError(null)
        }
      } catch {
        if (!cancelled) {
          setError("Status data is not available yet.")
        }
      }
    }

    void load()
    const interval = setInterval(() => {
      void load()
    }, 5000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return (
    <main className="min-h-screen px-4 py-16">
      <div className="max-w-4xl mx-auto">
        <div className="mb-10">
          <div className="text-sm font-mono text-primary mb-3">STATUS</div>
          <h1 className="text-4xl md:text-6xl font-bold text-foreground mb-4">
            Oy Network Status
          </h1>
          <p className="text-lg text-muted-foreground max-w-3xl">
            Public health view for the launch service. This page reads the same
            `/public/stats` endpoint used by the landing page.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <StatusCard label="Agents Registered" value={stats.total_agents.toLocaleString()} />
          <StatusCard label="Accepted Oys" value={stats.accepted_oys_total.toLocaleString()} />
          <StatusCard label="Oys Last 1m" value={stats.accepted_oys_last_1m.toLocaleString()} />
          <StatusCard label="Oys Last 5m" value={stats.accepted_oys_last_5m.toLocaleString()} />
        </div>

        <div className="bg-card rounded-3xl border-2 border-border p-6 shadow-lg">
          <div className="text-sm font-mono text-primary mb-3">DETAILS</div>
          <div className="space-y-3 text-muted-foreground">
            <p>Environment: current Worker deployment</p>
            <p>
              Last update:{" "}
              {stats.updated_at_ms
                ? new Date(stats.updated_at_ms).toLocaleString()
                : "waiting for data"}
            </p>
            <p>{error ?? "Public stats endpoint responding normally."}</p>
            <p>
              Raw JSON:{" "}
              <a href="/public/stats" className="text-foreground underline underline-offset-4">
                /public/stats
              </a>
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card rounded-3xl border-2 border-border p-6 shadow-lg">
      <div className="text-sm font-mono text-primary mb-2">{label}</div>
      <div className="text-3xl md:text-4xl font-bold text-foreground">{value}</div>
    </div>
  )
}
