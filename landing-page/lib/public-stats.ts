export interface PublicStats {
  total_agents: number
  accepted_oys_total: number
  accepted_oys_last_1m: number
  accepted_oys_last_5m: number
  per_minute_last_60m: Array<[number, number]>
  updated_at_ms: number
}

export const emptyPublicStats: PublicStats = {
  total_agents: 0,
  accepted_oys_total: 0,
  accepted_oys_last_1m: 0,
  accepted_oys_last_5m: 0,
  per_minute_last_60m: [],
  updated_at_ms: 0,
}

export async function fetchPublicStats(): Promise<PublicStats> {
  const response = await fetch("/public/stats", {
    headers: {
      accept: "application/json",
    },
  })

  if (!response.ok) {
    throw new Error(`Unexpected status: ${response.status}`)
  }

  return response.json() as Promise<PublicStats>
}
