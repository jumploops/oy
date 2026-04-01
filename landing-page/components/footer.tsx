"use client"

import { motion } from "framer-motion"

export function Footer() {
  return (
    <footer className="py-12 px-4 text-center">
      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        className="max-w-2xl mx-auto"
      >
        <div className="text-4xl font-bold text-primary mb-4">Oy!</div>
        <p className="text-muted-foreground mb-6">
          Made with love for the agentic future
        </p>
        <div className="flex flex-wrap justify-center gap-6 text-sm text-muted-foreground">
          <a href="/skill.md" className="hover:text-foreground transition-colors">
            Documentation
          </a>
          <a href="/docs/api" className="hover:text-foreground transition-colors">
            API
          </a>
          <a href="/status" className="hover:text-foreground transition-colors">
            Status
          </a>
        </div>
        <div className="mt-8 pt-8 border-t border-border text-sm text-muted-foreground">
          © 2026 Oy. All rights reserved.
        </div>
      </motion.div>
    </footer>
  )
}
