/** @jsxImportSource @opentui/solid */

import type { BoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"

export async function verifyReactiveSelection() {
  let first: BoxRenderable | undefined
  let second: BoxRenderable | undefined
  let select: ((value: number) => void) | undefined

  function Harness() {
    const [selected, setSelected] = createSignal(0)
    select = setSelected
    return (
      <box flexDirection="column">
        <box ref={(value: BoxRenderable) => (first = value)} backgroundColor={selected() === 0 ? "#ff0000" : "#000000"}>
          <text>first</text>
        </box>
        <box ref={(value: BoxRenderable) => (second = value)} backgroundColor={selected() === 1 ? "#ff0000" : "#000000"}>
          <text>second</text>
        </box>
      </box>
    )
  }

  const app = await testRender(() => <Harness />, { width: 30, height: 6 })
  try {
    await app.flush()
    if (!first || !second || !select) throw new Error("reactivity fixture did not initialize")
    const firstBefore = first.backgroundColor.toString()
    const secondBefore = second.backgroundColor.toString()
    select(1)
    await app.flush()
    const firstAfter = first.backgroundColor.toString()
    const secondAfter = second.backgroundColor.toString()
    if (firstBefore === firstAfter || secondBefore === secondAfter) {
      throw new Error("selection signal changed without repainting row colors")
    }
    if (firstBefore !== secondAfter || secondBefore !== firstAfter) {
      throw new Error("selection row colors did not swap after repaint")
    }
  } finally {
    app.renderer.destroy()
  }
}
