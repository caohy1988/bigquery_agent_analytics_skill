// Ids in the BQAA formats: 32-hex trace and event ids, 16-hex span ids
// (OpenTelemetry widths). `crypto.getRandomValues` is one of the web APIs a
// hooks module has.

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += HEX[b]
  return out
}

export type IdSource = {
  traceId: () => string
  spanId: () => string
  eventId: () => string
}

export const randomIds: IdSource = {
  traceId: () => randomHex(16),
  spanId: () => randomHex(8),
  eventId: () => randomHex(16),
}
