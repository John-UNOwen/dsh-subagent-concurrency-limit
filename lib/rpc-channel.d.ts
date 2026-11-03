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
/** The result envelope every endpoint returns. */
export type RpcChannelResult = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
        details: object;
    };
};
/** One channel's endpoint handler. */
export type RpcChannelHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcChannelResult>;
interface Injectable {
    inject(deps: string[], callback: (scope: unknown) => void): unknown;
}
/**
 * Mount one RPC channel. Without dsh's webServer and connection services (a
 * headless profile) nothing is mounted and the rest of the plugin is unaffected.
 * @param ctx - the plugin context.
 * @param channel - absolute channel prefix, such as /subagent-concurrency-limit.
 * @param handler - the endpoint handler.
 * @param maxBodyBytes - request body limit.
 */
export declare function mountRpcChannel(ctx: Injectable, channel: string, handler: RpcChannelHandler, maxBodyBytes?: number): void;
export {};
//# sourceMappingURL=rpc-channel.d.ts.map