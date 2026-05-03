import { createApp } from './app.ts'
import { buildAppDepsFromEnv, type RawEnv } from './config.ts'

export default {
  fetch(req: Request, env: RawEnv, ctx: ExecutionContext): Response | Promise<Response> {
    const app = createApp(buildAppDepsFromEnv(env))
    return app.fetch(req, env, ctx)
  },
}
