/**
 * Pure helpers for the dsh-timeline client half. No React, no plugin services —
 * only thin DOM/browser helpers and data transforms. Kept in one file so the
 * component (index.ts) stays focused on rendering and state, and so utility
 * logic is testable in isolation.
 */
/** One materialized chat node (user or steering message). */
export interface HistoryChatNode {
    kind?: string;
    key?: string;
    anchorSeq?: number;
    visibility?: string;
    data?: {
        seq?: number;
        time?: number;
        content?: readonly HistoryContentBlock[];
    };
}
/** One content block (structural subset: the text/image/tool shapes). */
export interface HistoryContentBlock {
    type?: string;
    text?: string;
    name?: string;
}
/** One rendered list row. */
export interface HistoryRow {
    seq: number;
    time: number;
    text: string;
    key: string | null;
}
/** One interaction turn from the host `/history/api/list-turns` route. */
export interface TurnItem {
    seq: number;
    time: number;
    userText: string;
    userAttachments: number;
    assistantText: string;
    toolCalls: number;
}
/** Truncate a string to at most `max` code units with an ellipsis. */
export declare function truncate(text: string, max: number): string;
/** Clamp a number into [min, max]. */
export declare function clamp(n: number, min: number, max: number): number;
/** Find the nearest overflow-y scroll ancestor of an element (the message
 *  viewport for rows inside the conversation). Pass `includeSelf` to also
 *  accept the element itself when it is the scrollport. */
export declare function findScrollPort(el: HTMLElement, includeSelf?: boolean): HTMLElement | null;
/** The conversation snapshot slice this plugin reads (structural subset). */
export interface HistoryConversationSnapshot {
    sessionId?: string;
    hasMore?: boolean;
    loadingOlder?: boolean;
    chat?: {
        nodes?: {
            values(): readonly HistoryChatNode[];
        };
    };
}
/** Flatten one message's content blocks to a single preview string. */
export declare function textOf(content: readonly HistoryContentBlock[] | undefined): string;
/** Format a Unix epoch ms timestamp: same-day → HH:mm; else YYYY-MM-DD HH:mm. */
export declare function fmtTime(ms: number): string;
/** Collect the user/steering messages in the loaded window + seq→key map. */
export declare function collectWindowItems(session: HistoryConversationSnapshot | undefined): {
    items: HistoryRow[];
    keys: Map<number, string>;
};
/** Find the conversation row DOM element for a chat-node anchor key. */
export declare function findAnchor(key: string): HTMLElement | null;
/** Drive the scrollport partway toward `target` while older history is still
 *  loading.  Clicking an unloaded turn scrolls up now so the motion starts
 *  immediately; each `loadOlder` page prepends above the top, so pinning
 *  toward the top keeps every newly loaded page entering the viewport and
 *  the view approaches the target before the exact jump lands.  Returns a
 *  cancel callback (the precise landing jump should stop this motion first,
 *  otherwise both rAF loops would fight over scrollTop). */
export declare function chaseScroll(port: HTMLElement, target: number, duration?: number): () => void;
/** Scroll a message row into view (top-aligned) and flash-highlight it.
 *  Positions the conversation scrollport directly with a short animated
 *  scroll (see animateScroll), rather than relying on async scrollIntoView
 *  which can silently no-op. */
export declare function scrollToKey(key: string): boolean;
/** Copy text to the clipboard (Clipboard API first, execCommand fallback). */
export declare function copyText(text: string): Promise<boolean>;
//# sourceMappingURL=util.d.ts.map