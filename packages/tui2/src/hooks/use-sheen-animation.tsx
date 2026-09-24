import React, { useCallback, useEffect, useState } from 'react'

import {
  SHADOW_CHARS,
  SHEEN_STEP,
  SHEEN_INTERVAL_MS,
} from '../branding/logo'
import { getSheenColor } from '../branding/logo'

interface UseSheenAnimationParams {
  logoColor: string
  accentColor: string
  blockColor: string
  terminalWidth: number | undefined
  sheenPosition: number
  setSheenPosition: (value: number | ((prev: number) => number)) => void
}

/**
 * Custom hook that handles the sheen animation effect on the logo
 * Animates a fill effect that loops: fill with accent color, then unfill back to original
 */
export function useSheenAnimation({
  logoColor,
  accentColor,
  blockColor,
  terminalWidth,
  sheenPosition,
  setSheenPosition,
}: UseSheenAnimationParams) {
  // Track whether we're in the reverse (unfill) phase
  const [isReversing, setIsReversing] = useState(false)

  // Run looping sheen animation
  useEffect(() => {
    const maxPosition = Math.max(10, Math.min((terminalWidth || 80) - 4, 100))
    const step = SHEEN_STEP

    const interval = setInterval(() => {
      setSheenPosition((prev) => {
        const next = prev + step
        
        if (next >= maxPosition) {
          // Reached the end, switch direction
          setIsReversing((wasReversing) => !wasReversing)
          return 0 // Reset position for next phase
        }
        
        return next
      })
    }, SHEEN_INTERVAL_MS)

    return () => {
      clearInterval(interval)
    }
  }, [terminalWidth, setSheenPosition])

  // Apply sheen effect to a character based on its position
  const applySheenToChar = useCallback(
    (char: string, charIndex: number) => {
      if (char === ' ' || char === '\n') {
        return <span key={charIndex}>{char}</span>
      }

      // Shadows and blocks keep their own colours; the accent fills in behind
      // the band on the way out and drains away on the way back.
      const base = SHADOW_CHARS.has(char) ? logoColor : blockColor
      const filled = isReversing ? charIndex >= sheenPosition : charIndex < sheenPosition
      const color = filled ? accentColor : getSheenColor(charIndex, sheenPosition, base, accentColor)

      return (
        <span key={charIndex} fg={color}>
          {char}
        </span>
      )
    },
    [sheenPosition, logoColor, accentColor, blockColor, isReversing],
  )

  return {
    applySheenToChar,
  }
}
