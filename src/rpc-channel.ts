/**
 * A Connection-style RPC channel registered directly on dsh's webServer.
 *
 * Adapted from better-er/dsh-pause (src/rpc-channel.ts), MIT License,
 * Copyright (c) 2026 betterer:
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the "Software"),
 *   to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense,
 *   and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 *   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 *
 * Why not `connection.rpc.handle`: registering through it resolves webServer
 * from the connection service's own context, which does not inject it, so a
 * plugin's call throws "cannot get property webServer without inject". dsh's
 * own /api route registers on webServer directly; so does this channel.
 *
 * Every request first passes `connection.requestRejection`: dsh's Host/Origin
 * checks and browser authentication. The envelope matches what dsh's browser
 * caller sends (`connection.rpc.call(channel, endpoint, payload)`): a POST to
 * `<channel>/<endpoint>` with `{ type: 'client-request', rpcId, method, payload }`,
 * answered with `{ type: 'server-response', rpcId, result }`.
 *
 * @module dsh-subagent-concurrency-limit/rpc-channel
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** The result envelope every endpoint returns. */
export type RpcChannelResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }

/** One channel's endpoint handler. */
export type RpcChannelHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcChannelResult>

/** The part of dsh's webServer service this channel uses. */
interface WebServerFace {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The part of dsh's connection service this channel uses: its request trust check. */
interface ConnectionFace {
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

interface Injectable {
  inject(deps: string[], callback: (scope: unknown) => void): unknown
}

interface Scope {
  connection: ConnectionFace
  webServer: WebServerFace
  effect(callback: () => (() => void) | undefined, label: string): unknown
}

/** Same as dsh's ENDPOINT_SEGMENT_PATTERN. */
const SEGMENT = /^[A-Za-z0-9_$.-]+$/
/** These endpoints take tiny payloads. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024
const JSON_MIME = 'application/json'

class PayloadTooLargeError extends Error {}

/**
 * Mount one RPC channel. Without dsh's webServer and connection services (a
 * headless profile) nothing is mounted and the rest of the plugin is unaffected.
 * @param ctx - the plugin context.
 * @param channel - absolute channel prefix, such as /subagent-concurrency-limit.
 * @param handler - the endpoint handler.
 * @param maxBodyBytes - request body limit.
 */
export function mountRpcChannel(
  ctx: Injectable,
  channel: string,
  handler: RpcChannelHandler,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): void {
  ctx.inject(['connection', 'webServer'], (raw) => {
    const scope = raw as Scope
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'prefix',
          path: channel,
          handler: (req, res) => serve(scope.connection, channel, handler, maxBodyBytes, req, res),
        }),
      `${channel}: rpc channel`,
    )
  })
}

async function serve(
  connection: ConnectionFace,
  channel: string,
  handler: RpcChannelHandler,
  maxBodyBytes: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (req.method !== 'POST') return missing(res)
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const prefix = `${channel}/`
  if (!pathname.startsWith(prefix)) return missing(res)
  const endpoint = pathname.slice(prefix.length)
  const parts = endpoint.split('/')
  if (!parts.every((part) => part !== '' && part !== '.' && part !== '..' && SEGMENT.test(part))) return missing(res)

  if (!isJsonContentType(req)) {
    res.writeHead(415)
    res.end('unsupported media type')
    return
  }
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBodyBytes) return tooLarge(req, res)

  let raw: string
  try {
    raw = await readBody(req, maxBodyBytes)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return tooLarge(req, res)
    res.writeHead(400)
    res.end('body read failed')
    return
  }
  let message: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  try {
    message = JSON.parse(raw) as typeof message
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
  if (message.type !== 'client-request' || typeof message.method !== 'string') {
    return reply(res, rpcId, {
      ok: false,
      error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} },
    })
  }
  if (message.method !== endpoint) {
    return reply(res, rpcId, {
      ok: false,
      error: { code: 'gateway/bad-request', message: 'method does not match the endpoint', details: {} },
    })
  }
  const controller = new AbortController()
  const onClose = (): void => {
    controller.abort(new Error('client disconnected'))
  }
  res.on('close', onClose)
  let result: RpcChannelResult
  try {
    result = await handler(endpoint, message.payload, controller.signal)
  } catch (error) {
    result = {
      ok: false,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
    }
  } finally {
    res.off('close', onClose)
  }
  reply(res, rpcId, result)
}

function missing(res: ServerResponse): void {
  res.writeHead(404)
  res.end('not found')
}

function reply(res: ServerResponse, rpcId: string, result: RpcChannelResult): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/** Write the 413 before destroying the socket, or it never goes out. */
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(413, { connection: 'close' })
  res.end('payload too large')
  req.destroy()
}

function isJsonContentType(req: IncomingMessage): boolean {
  const header = req.headers['content-type']
  if (typeof header !== 'string') return false
  const mime = header.split(';', 1)[0]
  return mime !== undefined && mime.trim().toLowerCase() === JSON_MIME
}

async function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buffer.length
    if (size > maxBodyBytes) throw new PayloadTooLargeError('request body exceeds the limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
