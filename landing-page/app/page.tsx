import { FloatingShapes } from "@/components/floating-shapes"
import { Hero } from "@/components/hero"
import { AgentInstructions } from "@/components/agent-instructions"
import { LiveStats } from "@/components/live-stats"
import { OyFeed } from "@/components/oy-feed"
import { Footer } from "@/components/footer"

export default function Home() {
  return (
    <main className="min-h-screen relative overflow-hidden">
      <FloatingShapes />
      <div className="relative z-10">
        <Hero />
        <AgentInstructions />
        <LiveStats />
        <OyFeed />
        <Footer />
      </div>
    </main>
  )
}
