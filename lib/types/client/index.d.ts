/**
 * dsh-timeline client half: the interaction-turn timeline rail on the right
 * edge of the message area (spec F2-F5). One short tick per turn; the
 * active turn is highlighted and centered, clamped at the ends.
 *
 * Reuses DSH-native interfaces where possible:
 * - `conversation.input.dock` slot for the entry point;
 * - the product's `data-chat-anchor-key` semantic anchor + `session.loadOlder()`
 *   for jump/auto-load (see util.ts).
 * Pure helpers live in ./util.ts; this file only renders and manages state.
 */
import { type ReactElement } from 'react';
import type { Context } from 'cordis';
import { type HistoryConversationSnapshot } from './util';
/** ------------------------------------------------------------------ types */
/** The client slots service face (structural subset used here). */
interface HistorySlotsService {
    inject(key: string, callback: () => () => void): () => void;
    register(options: {
        name: string;
        id?: string;
        order?: number;
    }, component: (props: HistoryDockProps) => ReactElement): () => void;
}
/** The client sessions service face (structural subset used here). */
interface ClientSessionsService {
    binding(id: string): {
        session: {
            loadOlder(): Promise<void>;
        };
    } | undefined;
}
/** Props the dock slot renders with. */
interface HistoryDockProps {
    session?: HistoryConversationSnapshot;
}
/** Timer service face (optional; used to auto-clear the flash feedback). */
interface HistoryTimer {
    timeout(callback: () => void, delay: number): () => void;
}
declare module 'cordis' {
    interface Context {
        slots: HistorySlotsService;
        sessions?: ClientSessionsService;
        timer?: HistoryTimer;
    }
}
/** ------------------------------------------------------------------ plugin */
/** Services required before mounting: the slot registry. */
export declare const inject: string[];
/**
 * Client plugin body: inject the stylesheet and register the dock row.
 * @param ctx - client plugin context (slots, sessions, timer).
 */
export declare function apply(ctx: Context): void;
export {};
//# sourceMappingURL=index.d.ts.map