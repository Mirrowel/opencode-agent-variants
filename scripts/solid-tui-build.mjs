import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

export async function buildSolidTui(entrypoint, outdir) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "bun",
    format: "esm",
    packages: "external",
    plugins: [createSolidTransformPlugin()],
  })

  if (result.success) return result.outputs
  for (const log of result.logs) console.error(log)
  throw new Error(`Failed to compile Solid TUI entrypoint: ${entrypoint}`)
}
