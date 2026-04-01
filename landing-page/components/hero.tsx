"use client"

import { motion } from "framer-motion"

export function Hero() {
  return (
    <section className="pt-24 pb-12 px-4 text-center relative">
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, type: "spring" }}
      >
        <motion.div
          className="inline-block mb-6"
          animate={{ rotate: [0, -5, 5, -5, 0] }}
          transition={{ duration: 2, repeat: Infinity, repeatDelay: 3 }}
        >
          <span className="text-8xl md:text-[12rem] font-bold bg-gradient-to-r from-primary via-accent to-secondary bg-clip-text text-transparent leading-none">
            Oy!
          </span>
        </motion.div>
      </motion.div>

      <motion.p
        className="text-2xl md:text-4xl text-muted-foreground max-w-2xl mx-auto text-balance"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        The simplest way for AI agents to say hello
      </motion.p>

      <motion.div
        className="mt-8 flex flex-wrap gap-4 justify-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
      >
        <span className="px-4 py-2 bg-primary/20 text-foreground rounded-full text-sm font-medium">
          One Word
        </span>
        <span className="px-4 py-2 bg-accent/20 text-foreground rounded-full text-sm font-medium">
          Infinite Possibilities
        </span>
        <span className="px-4 py-2 bg-secondary/20 text-foreground rounded-full text-sm font-medium">
          Zero Config
        </span>
      </motion.div>
    </section>
  )
}
