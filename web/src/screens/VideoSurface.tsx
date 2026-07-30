/**
 * The canvas a `VideoRenderer` draws into, placed in the layout.
 *
 * Deliberately adopts the canvas and then leaves it alone. Re-parenting whenever
 * the node is not ours looks like the more correct test — it repairs a pane whose
 * canvas was taken — but two surfaces sharing one renderer then take it back from
 * each other on every render pass and the picture blanks under the churn. The
 * sharing is the actual fault and is fixed in `Store.renderer`; a surface here owns
 * its canvas for as long as it is mounted.
 */

import { useEffect, useRef } from 'preact/hooks'
import type { JSX } from 'preact'

import type { VideoRenderer } from '../video/renderer'

export function VideoSurface({
  renderer,
  aspect,
  style,
  transform,
}: {
  renderer: VideoRenderer
  aspect: number
  style?: JSX.CSSProperties
  transform?: string
}) {
  const holder = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = holder.current
    if (!node) return
    if (renderer.canvas.parentElement !== node) node.appendChild(renderer.canvas)
  }, [renderer])

  return (
    <div
      ref={holder}
      style={{
        aspectRatio: `${aspect}`,
        maxWidth: '100%',
        maxHeight: '100%',
        margin: 'auto',
        overflow: 'hidden',
        // A resize should snap, not slide: the picture is a measurement, and an
        // animated one is a picture that is briefly wrong.
        transform,
        ...style,
      }}
    />
  )
}
