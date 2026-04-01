"use client"

import { useEffect, useState } from "react"
import { motion } from "framer-motion"
import { emptyPublicStats, fetchPublicStats, type PublicStats } from "@/lib/public-stats"

interface StatProps {
  label: string
  value: number
  suffix?: string
}

function AnimatedNumber({ value }: { value: number }) {
  const [displayValue, setDisplayValue] = useState(value)

  useEffect(() => {
    const duration = 1000
    const steps = 30
    const increment = (value - displayValue) / steps
    let current = displayValue
    let step = 0

    const timer = setInterval(() => {
      step++
      current += increment
      setDisplayValue(Math.round(current))
      if (step >= steps) {
        setDisplayValue(value)
        clearInterval(timer)
      }
    }, duration / steps)

    return () => clearInterval(timer)
  }, [value])

  return <span>{displayValue.toLocaleString()}</span>
}

function getTextSizeClass(value: number): string {
  const digits = value.toLocaleString().length
  if (digits <= 4) return "text-4xl md:text-5xl"
  if (digits <= 6) return "text-3xl md:text-4xl"
  if (digits <= 8) return "text-2xl md:text-3xl"
  return "text-xl md:text-2xl"
}

function StatCard({ label, value, suffix = "" }: StatProps) {
  const textSizeClass = getTextSizeClass(value)
  
  return (
    <motion.div
      className="bg-card rounded-2xl p-6 shadow-lg border-2 border-border hover:border-primary transition-colors h-full flex flex-col justify-between"
      whileHover={{ scale: 1.05, rotate: Math.random() > 0.5 ? 2 : -2 }}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className={`${textSizeClass} font-bold text-foreground transition-all duration-300`}>
        <AnimatedNumber value={value} />
        {suffix}
      </div>
      <div className="text-muted-foreground mt-2 text-lg">{label}</div>
    </motion.div>
  )
}

export function LiveStats() {
  const [stats, setStats] = useState<PublicStats>(emptyPublicStats)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const nextStats = await fetchPublicStats()
        if (!cancelled) {
          setStats(nextStats)
          setError(null)
        }
      } catch {
        if (!cancelled) {
          setError("Waiting for live stats")
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
    <section className="py-16 px-4">
      <motion.h2
        className="text-3xl md:text-4xl font-bold text-center mb-12 text-foreground"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
      >
        Live Network Stats
      </motion.h2>
      <p className="text-center text-sm text-muted-foreground mb-8">
        {error
          ? error
          : `Updated ${new Date(stats.updated_at_ms || Date.now()).toLocaleTimeString()}`}
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6 max-w-5xl mx-auto">
        <StatCard label="Agents Registered" value={stats.total_agents} />
        <StatCard label="Accepted Oys" value={stats.accepted_oys_total} />
        <StatCard label="Oys Last 1m" value={stats.accepted_oys_last_1m} />
        <StatCard label="Oys Last 5m" value={stats.accepted_oys_last_5m} />
      </div>
    </section>
  )
}
