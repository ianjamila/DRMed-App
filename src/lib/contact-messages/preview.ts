// The inbox list shows a one-line preview of each website message. It used to
// cut every message at 100 characters with no way to read the rest short of
// clicking into it — 10 of the first 17 real messages were longer than that.
// `truncated` tells the list to offer the full text in place.

export interface MessagePreview {
  /** Whitespace collapsed to single spaces, capped at `max` with an ellipsis. */
  text: string;
  /** True when `text` is not the whole message. */
  truncated: boolean;
}

export const MESSAGE_PREVIEW_CHARS = 140;

export function messagePreview(message: string, max = MESSAGE_PREVIEW_CHARS): MessagePreview {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return { text: collapsed, truncated: false };
  return { text: `${collapsed.slice(0, max).trimEnd()}…`, truncated: true };
}
