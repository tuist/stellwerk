export type Logger = (msg: string, fields?: Record<string, unknown>) => void

export const defaultLog: Logger = (msg, fields) => {
  console.log(JSON.stringify({ msg, ...fields, ts: new Date().toISOString() }))
}
