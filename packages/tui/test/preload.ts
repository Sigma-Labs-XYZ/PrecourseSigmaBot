import { NativeError, NativeStatus, OptimizedBuffer } from "@opentui/core"

// Keep tests from attaching to an editor running on this machine: a live selection would be sent as
// extra editor context. Nothing listens on port 1, so the editor client never connects.
delete process.env.CLAUDE_CODE_SSE_PORT
process.env.OPENCODE_EDITOR_SSE_PORT = "1"

// Workaround: OpenTUI's test renderer can read a frame while the native writer is still flushing
// output, which throws OutputBusy until the event loop runs. Frame reads poll, so fall back to the
// last frame read from the buffer. Remove once captureCharFrame waits for output idle upstream.
const frames = new WeakMap<OptimizedBuffer, Uint8Array>()
const getRealCharBytes = OptimizedBuffer.prototype.getRealCharBytes
OptimizedBuffer.prototype.getRealCharBytes = function (addLineBreaks) {
  try {
    const bytes = getRealCharBytes.call(this, addLineBreaks)
    frames.set(this, bytes)
    return bytes
  } catch (error) {
    if (!(error instanceof NativeError) || error.status !== NativeStatus.OutputBusy) throw error
    return frames.get(this) ?? new Uint8Array()
  }
}
