/**
 * The canvas a `VideoRenderer` draws into, placed in the layout.
 *
 * Deliberately adopts the canvas and then leaves it alone. Re-parenting whenever
 * the node is not ours looks like the more correct test — it repairs a pane whose
 * canvas was taken — but two surfaces sharing one renderer then take it back from
 * each other on every render pass and the picture blanks under the churn. The
 * sharing is the actual fault and is fixed in `Store.renderer`; a surface here owns
 * its canvas for as long as it is mounted.
 *
 * It owns *one*, though, and that is the part this got wrong. A surface outlives
 * the renderer it was first given — switching MON 1 to MON 2 restarts the stream
 * under new numbering, so the same mounted surface is handed a different
 * `VideoRenderer` — and appending the new canvas without removing the old one left
 * two stacked in the same box. The stale one is the first child, so the picture on
 * screen stayed on the display the user had just switched away from while the tab
 * above it read MON 2. iOS never had this: `VideoSurfaceView.attach` removes the
 * previous layer before adding the next one, which is what this now does.
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
    // Evict whatever the last renderer left here before adopting this one. Only
    // ever one canvas of ours at a time.
    for (const child of [...node.children]) {
      if (child !== renderer.canvas) child.remove()
    }
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
