import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types";

// @lat: [[chat-performance#Bottom follow ownership]]
export function useChatScroll(
  messages: ChatMessage[],
  scope = "chat",
): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  isFollowing: boolean;
  jumpToLatest: () => void;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const previousTopRef = useRef(0);
  const prevMessageCountRef = useRef(messages.length);
  const initialScrollDoneRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);
  const follow = useCallback((value: boolean) => {
    followingRef.current = value;
    setIsFollowing(value);
  }, []);
  const writeBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    // Instant writes have no intermediate smooth-scroll positions that could
    // be mistaken for manual reading. Read the latest dimensions at delivery.
    container.scrollTop = Math.max(
      0,
      container.scrollHeight - container.clientHeight,
    );
    previousTopRef.current = container.scrollTop;
  }, []);
  const scheduleFollow = useCallback(() => {
    if (!followingRef.current || frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      if (followingRef.current) writeBottom();
    });
  }, [writeBottom]);
  const jumpToLatest = useCallback(() => {
    follow(true);
    scheduleFollow();
  }, [follow, scheduleFollow]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    initialScrollDoneRef.current = false;
    prevMessageCountRef.current = 0;
    previousTopRef.current = container.scrollTop;
    follow(true);
    const pause = (): void => {
      follow(false);
      cancelFrame();
    };
    const handleScroll = (): void => {
      const top = container.scrollTop;
      const bottomDistance =
        container.scrollHeight - top - container.clientHeight;
      // Lazy row sizing can clamp scrollTop downward at the actual bottom.
      // That correction is not upward reading; allow subpixel rounding only.
      if (top < previousTopRef.current && bottomDistance >= 1) pause();
      else if (bottomDistance < 60 && top > previousTopRef.current)
        follow(true);
      // Height growth alone does not imply a change in the reader's intent.
      previousTopRef.current = top;
    };
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0 && container.scrollHeight > container.clientHeight)
        pause();
    };
    const handleKey = (event: KeyboardEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false" i])',
        )
      )
        return;
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      )
        pause();
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("keydown", handleKey);
    // The viewport alone does not resize when an existing transcript row
    // grows. Observe the block-flow content too, including media/lazy layout.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleFollow);
    observer?.observe(container);
    observer?.observe(content);
    return () => {
      cancelFrame();
      observer?.disconnect();
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("keydown", handleKey);
    };
  }, [scope, cancelFrame, follow, scheduleFollow]);

  useLayoutEffect(() => {
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (messages.length === 0) {
      initialScrollDoneRef.current = false;
      return;
    }
    if (!initialScrollDoneRef.current || prevCount === 0) {
      initialScrollDoneRef.current = true;
      follow(true);
      cancelFrame();
      // History loads remain instant before the top expansion observer runs.
      writeBottom();
      return;
    }
    if (
      messages.length > prevCount &&
      messages[messages.length - 1]?.role === "user"
    )
      follow(true);
    scheduleFollow();
  }, [messages, scope, cancelFrame, follow, scheduleFollow, writeBottom]);

  return { containerRef, contentRef, bottomRef, isFollowing, jumpToLatest };
}
