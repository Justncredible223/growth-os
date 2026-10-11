/**
 * Chat that asks the candle to move ("dance", "spin", "jump"...). A move is physical and instant: it is played on the
 * stage, with no model call and no spoken answer. A message that is only a move request is therefore not answered
 * (answering "dance" with a sentence about not having legs was the worst of both).
 */
export const MOVE_WORDS = ["dance", "spin", "jump", "moonwalk", "wave", "flex"] as const;

const MOVE_ANYWHERE = /\b(dance|dancing|spin|jump|moonwalk|wave|flex)\b/i;
const PURE_MOVE = /^\W*(?:(?:hey|yo|ok|okay|pls|plz|please|tilt|can you|could you|come on|c'mon)\s+)*(?:(?:do|make|go|show)\s+(?:a|the|some|us a|me a)\s+)?(dance|dancing|spin|jump|moonwalk|wave|flex)(?:\s+(?:tilt|please|pls|plz|now|for us|for me|bro|man|lol|lmao|again|more))*\W*$/i;

/** The move a chat message asks for, if it contains one of the move words. */
export function moveWord(body: string): string | null {
  const match = MOVE_ANYWHERE.exec(body);
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  return word === "dancing" ? "dance" : word;
}

/** The move, when the whole message is just a request for it. */
export function pureMoveRequest(body: string): string | null {
  const match = PURE_MOVE.exec(body.trim());
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  return word === "dancing" ? "dance" : word;
}
