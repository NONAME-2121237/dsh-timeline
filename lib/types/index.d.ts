/**
 * dsh-timeline host half: one fenced HTTP route `/history/api` that reads the
 * complete session log through `sessionQuery` and returns every `user/message`
 * event the human sent — including messages outside the client's currently
 * loaded window (compacted-over, paged-out, or older than the first page).
 *
 * The client half (lib/client.js) calls this route with plain `fetch`
 * (a third-party plugin resolves outside the DSH monorepo, so it has no
 * `host.call` — the fenced HTTP route is the cross-half channel).
 */
import type { Context } from 'cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
/** The webServer service face this plugin uses (structural mirror). */
interface HistoryWebServer {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
/** The web runtime service face: bind-derived trusted authorities. */
interface HistoryWebRuntime {
    trustedHosts: readonly string[];
}
/** The session-query service face: exact reads over the live-preferred corpus. */
interface HistorySessionQuery {
    readSession(sessionId: string): Promise<{
        events?: readonly HistorySessionEvent[];
    }>;
}
/** One raw session-log event (structural subset used by the filter). */
interface HistorySessionEvent {
    type?: string;
    seq?: number;
    time?: number;
    data?: {
        source?: {
            kind?: string;
        };
        content?: readonly HistoryContentBlock[];
        chunk?: {
            type?: string;
            text?: string;
        };
    };
}
/** One content block (structural subset: the text/image/tool shapes). */
interface HistoryContentBlock {
    type?: string;
    text?: string;
    name?: string;
}
declare module 'cordis' {
    interface Context {
        webServer: HistoryWebServer;
        webRuntime: HistoryWebRuntime;
        sessionQuery?: HistorySessionQuery;
    }
}
/** Stable plugin name for the cordis row. */
export declare const name = "dsh-timeline";
/** Services required before mounting: the web server routes and the trust list. */
export declare const inject: string[];
/**
 * Plugin body: mount the fenced /history/api route.
 * @param ctx - host plugin context (webServer, webRuntime).
 */
export declare function apply(ctx: Context): void;
export {};
//# sourceMappingURL=index.d.ts.map