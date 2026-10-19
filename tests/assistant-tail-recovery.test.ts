import { describe, expect, it } from "vitest";
import { reconcileStreamedWithDb } from "../src/renderer/src/screens/Chat/sessionHistory";
import type {
  ChatBubbleMessage,
  ChatMessage,
} from "../src/renderer/src/screens/Chat/types";

const prefix =
  "A substantive assistant response with a stable paragraph. ".repeat(8);
function reconcile(
  streamed: string,
  canonical: string,
  role: "agent" | "user" = "agent",
): ChatBubbleMessage {
  const live: ChatMessage = { id: "live-row", role, content: streamed };
  const db: ChatMessage = {
    id: "db-10",
    role,
    content: canonical,
    timestamp: 12,
  };
  const merged = reconcileStreamedWithDb([live], [db]);
  expect(merged).toHaveLength(1);
  expect(merged[0].id).toBe("live-row");
  expect("timestamp" in merged[0] && merged[0].timestamp).toBe(12);
  return merged[0] as ChatBubbleMessage;
}

describe("canonical assistant tail recovery", () => {
  // @lat: [[chat-commands#Canonical database tail recovery#Incomplete matched assistant row]]
  it.each([" ", "\n\n", "\t"])(
    "adopts a substantive database continuation while retaining live identity (%j)",
    (separator) => {
      const streamed = prefix.replaceAll(" ", separator) + "The result is";
      const canonical =
        prefix +
        "The result is complete, including the missing final sentence.";
      expect(reconcile(streamed, canonical).content).toBe(canonical);
    },
  );

  // @lat: [[chat-commands#Canonical database tail recovery#Structural wrappers alone do not replace text]]
  it.each([
    '\n\n<file name="notes.txt" mime="text/plain">\nraw attachment bytes\n</file>',
    "\n[screenshot]",
    "\n[image]",
  ])(
    "keeps readable streamed text when the database adds only %j",
    (wrapper) => {
      const streamed = prefix + "Complete response.";
      expect(reconcile(streamed, streamed + wrapper).content).toBe(streamed);
    },
  );

  // @lat: [[chat-commands#Canonical database tail recovery#Divergent and shorter canonical rows do not overwrite]]
  it.each([
    [
      prefix + "Stream-specific ending.",
      prefix + "Different database ending that is longer.",
    ],
    [
      prefix + "Complete response with a later streamed sentence.",
      prefix + "Complete response",
    ],
  ])(
    "retains a divergent or more complete live reply",
    (streamed, canonical) => {
      expect(reconcile(streamed, canonical).content).toBe(streamed);
    },
  );

  // @lat: [[chat-commands#Canonical database tail recovery#User submissions retain their original content]]
  it("does not rewrite an optimistic user submission from a longer database record", () => {
    const streamed = prefix + "Original user request.";
    expect(
      reconcile(streamed, streamed + " Extra backend context.", "user").content,
    ).toBe(streamed);
  });
});
