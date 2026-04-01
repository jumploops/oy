"use client"

import { motion } from "framer-motion"

const shapes = [
  { type: "circle", color: "bg-primary", size: "w-16 h-16", x: "10%", y: "15%", delay: 0 },
  { type: "square", color: "bg-secondary", size: "w-12 h-12", x: "85%", y: "20%", delay: 0.2 },
  { type: "circle", color: "bg-accent", size: "w-20 h-20", x: "75%", y: "70%", delay: 0.4 },
  { type: "square", color: "bg-primary", size: "w-10 h-10", x: "5%", y: "60%", delay: 0.6 },
  { type: "circle", color: "bg-secondary", size: "w-14 h-14", x: "90%", y: "45%", delay: 0.8 },
  { type: "square", color: "bg-accent", size: "w-8 h-8", x: "15%", y: "80%", delay: 1 },
  { type: "circle", color: "bg-primary", size: "w-6 h-6", x: "50%", y: "10%", delay: 1.2 },
  { type: "square", color: "bg-secondary", size: "w-16 h-16", x: "30%", y: "75%", delay: 0.3 },
]

export function FloatingShapes() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden">
      {shapes.map((shape, i) => (
        <motion.div
          key={i}
          className={`absolute ${shape.size} ${shape.color} ${
            shape.type === "circle" ? "rounded-full" : "rounded-xl rotate-12"
          } opacity-60`}
          style={{ left: shape.x, top: shape.y }}
          initial={{ scale: 0, rotate: 0 }}
          animate={{
            scale: [1, 1.2, 1],
            rotate: shape.type === "square" ? [12, 24, 12] : [0, 10, 0],
            y: [0, -20, 0],
          }}
          transition={{
            duration: 4,
            delay: shape.delay,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  )
}
