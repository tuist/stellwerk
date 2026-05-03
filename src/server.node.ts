import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { buildAppDepsFromEnv } from './config.ts'

const port = Number(process.env.PORT ?? 8787)
const app = createApp(buildAppDepsFromEnv(process.env))

serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ msg: 'stellwerk listening', port: info.port }))
})
