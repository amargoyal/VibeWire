import { Caps, Card, OutlinedAction, Segmented, Toggle } from '../../../src/design/components'
import { Kv, PaneHeading } from '../parts'
import { resolution } from '../format'
import { send, type DisplayFact, type Facts } from '../store'

/**
 * 03 · DISPLAYS.
 *
 * What ScreenCaptureKit reports, what the encoder is doing with each one, and
 * the two controls that belong at the Mac rather than on the phone: which
 * display is sent, and the ladder it is sent at.
 *
 * There is no START CAPTURE. Starting a stream with nothing attached would
 * encode frames with nowhere to send them; selecting a display here records the
 * choice and a live session picks it up, which is the honest shape of the
 * control. STOP is offered only while something is running.
 */
export function Displays({ state }: { state: Facts }) {
  const ladder = state.settings?.quality ?? 'auto'

  return (
    <div class="pane" data-screen-label="Displays">
      <PaneHeading
        title="Displays"
        caption="SCREENCAPTUREKIT · ONE ENCODER PER DISPLAY · 60 FPS TARGET"
      >
        <div style={{ width: 300 }}>
          <Segmented
            label="Quality ladder"
            selection={ladder}
            options={[
              { value: 'auto', label: 'AUTO' },
              { value: '1080', label: '1080' },
              { value: '720', label: '720' },
              { value: '540', label: '540' },
            ]}
            onSelect={(value) => void send({ do: 'setting.set', key: 'quality', value })}
          />
        </div>
      </PaneHeading>

      {!state.permissions.screenRecording && (
        <Card tint="var(--ns-amber)" style={{ padding: 18, flex: '0 0 auto' }}>
          <div class="stack" style={{ gap: 11 }}>
            <Caps size="var(--fs-9)" color="var(--ns-amber)">
              SCREEN RECORDING NOT GRANTED
            </Caps>
            <span
              style={{
                fontSize: 'var(--fs-13)',
                lineHeight: 1.45,
                color: 'var(--ns-on-amber-wash)',
                textWrap: 'pretty',
              }}
            >
              ScreenCaptureKit has no frames to send, so the phone shows an empty picture. The
              displays below are still enumerated; nothing can be captured from them.
            </span>
            <OutlinedAction
              title="GRANT SCREEN RECORDING…"
              tint="var(--ns-amber)"
              edge="var(--ns-amber)"
              onClick={() => void send({ do: 'permission.request', which: 'screen' })}
            />
          </div>
        </Card>
      )}

      <div class="row" style={{ gap: 16, alignItems: 'stretch', flex: '0 0 auto' }}>
        {state.displays.map((display) => (
          <DisplayCard key={display.id} display={display} state={state} />
        ))}
        {state.displays.length === 0 && (
          <Card style={{ padding: 18, flex: '1 1 auto' }}>
            <Caps size="var(--fs-9)">NO DISPLAY REPORTED</Caps>
          </Card>
        )}
      </div>

      {state.displays.length > 1 && (
        <div
          class="row group-row group-row--dashed"
          style={{ gap: 14, minHeight: 58, flex: '0 0 auto' }}
        >
          <span class="row" style={{ gap: 4 }}>
            <span
              style={{
                width: 14,
                height: 19,
                borderRadius: 'var(--radius-screen)',
                border: '1px solid var(--ns-text-tertiary)',
              }}
            />
            <span
              style={{
                width: 14,
                height: 19,
                borderRadius: 'var(--radius-screen)',
                border: '1px solid var(--ns-text-tertiary)',
              }}
            />
          </span>
          <Caps size="var(--fs-10)" color="var(--ns-text-secondary)">
            SIDE BY SIDE · SENDS BOTH DISPLAYS AS ONE PICTURE · NEEDS 3 MB/S
          </Caps>
          <span class="spacer" />
          <Toggle
            label="Side by side"
            isOn={state.sideBySide}
            onChange={(on) =>
              void send({
                do: 'display.select',
                displayIds: on
                  ? state.displays.map((display) => display.id)
                  : [
                      (state.displays.find((display) => display.selected) ??
                        state.displays.find((display) => display.isMain) ??
                        state.displays[0])!.id,
                    ],
                sideBySide: on,
              })
            }
          />
        </div>
      )}
    </div>
  )
}

function DisplayCard({ display, state }: { display: DisplayFact; state: Facts }) {
  const stream = display.stream
  const tint = stream ? 'var(--ns-green)' : 'var(--ns-text-tertiary)'

  return (
    <Card style={{ flex: '1 1 0', minWidth: 0, padding: 16 }}>
      <div class="stack" style={{ gap: 14, height: '100%' }}>
        <div
          style={{
            position: 'relative',
            aspectRatio: '16 / 10',
            borderRadius: 'var(--radius-inner)',
            overflow: 'hidden',
            background: stream
              ? 'repeating-linear-gradient(135deg, var(--ns-raised-2) 0 8px, var(--ns-raised) 8px 16px)'
              : 'repeating-linear-gradient(135deg, var(--ns-raised) 0 8px, var(--ns-chrome) 8px 16px)',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 10,
              borderRadius: 'var(--radius-screen)',
              border: `1px ${stream ? 'solid' : 'dashed'} var(--ns-stroke)`,
            }}
          />
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <Caps size="var(--fs-10)" tracking="var(--caps-tracking-wide)" color="var(--ns-text-disabled)">
              {display.isMain ? 'MAIN' : display.isBuiltIn ? 'BUILT-IN' : 'EXTERNAL'}
            </Caps>
          </div>
          <span class="video-chip mono" style={{ position: 'absolute', left: 12, top: 12, color: tint }}>
            {stream ? 'CAPTURING' : 'NOT SENT'}
          </span>
        </div>

        <div class="stack" style={{ gap: 5 }}>
          <span
            class="ellipsis"
            style={{ fontSize: 'var(--fs-19)', fontWeight: 600, letterSpacing: 'var(--title-tracking)' }}
          >
            {display.name}
          </span>
          <Caps size="var(--fs-9)">
            {`${resolution(display.width, display.height)} @ ${display.hz}HZ`}
          </Caps>
        </div>

        <div class="stack" style={{ gap: 2 }}>
          <Kv label="STREAM" value={stream ? String(stream.streamId) : null} boxed />
          <Kv
            label="SENT AT"
            value={stream ? resolution(stream.sentWidth, stream.sentHeight) : null}
            boxed
          />
          <Kv label="RATE" value={stream ? `${stream.mbps.toFixed(1)} MB/S` : null} boxed />
          <Kv
            label="FRAMES"
            value={stream ? stream.frames.toLocaleString() : null}
            boxed
          />
          <Kv label="LADDER" value={stream ? `${stream.ladder}P · ${stream.fps} FPS` : null} boxed />
          <Kv label="GOP" value={stream ? String(stream.gop) : null} boxed />
        </div>

        <span class="spacer" />

        {stream ? (
          <OutlinedAction title="STOP CAPTURE" onClick={() => void send({ do: 'capture.stop' })} />
        ) : (
          <OutlinedAction
            title={display.selected ? 'SELECTED' : 'SEND THIS DISPLAY'}
            enabled={!display.selected}
            onClick={() =>
              void send({ do: 'display.select', displayIds: [display.id], sideBySide: false })
            }
          />
        )}

        {!stream && display.selected && (
          <Caps size="var(--fs-9)" style={{ lineHeight: 1.6 }}>
            {state.link.attached
              ? 'CHOSEN · THE PHONE STARTS THE STREAM'
              : 'CHOSEN · NOTHING IS ATTACHED TO SEND IT TO'}
          </Caps>
        )}
      </div>
    </Card>
  )
}
