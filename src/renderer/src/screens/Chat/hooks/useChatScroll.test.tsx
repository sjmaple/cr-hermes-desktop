import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatScroll } from "./useChatScroll";
import type { ChatMessage } from "../types";

const messages: ChatMessage[] = [
  { id: "user", role: "user", content: "Question" },
  { id: "reply", role: "agent", content: "Answer" },
];
let height = 700;
let top = 400;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let smoothEnds: number[] = [];
const observers: Array<{
  callback: ResizeObserverCallback;
  targets: Set<Element>;
  disconnected: boolean;
}> = [];

function Harness({
  scope = "first",
  rows = messages,
}: {
  scope?: string;
  rows?: ChatMessage[];
}): React.JSX.Element {
  const api = useChatScroll(rows, scope);
  return (
    <>
      <div ref={api.containerRef} data-testid="viewport">
        <div ref={api.contentRef} data-testid="transcript">
          {rows.map((row) => (
            <p key={row.id}>{"content" in row ? row.content : ""}</p>
          ))}
          <div ref={api.bottomRef} />
        </div>
      </div>
      {!api.isFollowing && (
        <button onClick={api.jumpToLatest}>Jump to latest</button>
      )}
    </>
  );
}
function flush(): void {
  act(() => {
    const current = [...frames.values()];
    frames.clear();
    current.forEach((callback) => callback(1));
    for (const end of smoothEnds.splice(0)) top = end;
  });
}
function resize(): void {
  act(() =>
    observers
      .filter((o) => !o.disconnected)
      .forEach((o) => o.callback([], {} as ResizeObserver)),
  );
}
function mount(): ReturnType<typeof render> {
  const view = render(<Harness />);
  const viewport = screen.getByTestId("viewport");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => 300 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.min(value, height - 300);
      },
    },
  });
  resize();
  flush();
  return view;
}
beforeEach(() => {
  height = 700;
  top = 400;
  frames.clear();
  observers.splice(0);
  smoothEnds = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      record: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: new Set(), disconnected: false };
        observers.push(this.record);
      }
      observe(element: Element): void {
        this.record.targets.add(element);
      }
      disconnect(): void {
        this.record.disconnected = true;
      }
    },
  );
  Element.prototype.scrollIntoView = vi.fn(function (
    this: Element,
    options?: ScrollIntoViewOptions,
  ) {
    if (options?.behavior === "smooth") {
      smoothEnds.push(height - 300);
      top += 30;
      fireEvent.scroll(
        this.parentElement?.parentElement || this.parentElement!,
      );
    } else top = height - 300;
  });
});
afterEach(() => vi.unstubAllGlobals());

// @lat: [[chat-performance#Bottom follow ownership#Smooth intermediate positions retain following]]
it("coalesces streamed growth without smooth intermediate scroll events disabling follow", () => {
  const view = mount();
  height = 1000;
  view.rerender(
    <Harness
      rows={[
        messages[0],
        { ...messages[1], content: "Longer reply" } as ChatMessage,
      ]}
    />,
  );
  height = 1300;
  view.rerender(
    <Harness
      rows={[
        messages[0],
        { ...messages[1], content: "Even longer reply" } as ChatMessage,
      ]}
    />,
  );
  flush();
  expect(top).toBe(1000);
  expect(
    screen.queryByRole("button", { name: "Jump to latest" }),
  ).not.toBeInTheDocument();
});

// @lat: [[chat-performance#Bottom follow ownership#Existing rows and viewport resizing]]
it("follows asynchronous growth of an existing row and viewport layout without a message-count change", () => {
  mount();
  height = 1400;
  resize();
  resize();
  expect(frames.size).toBe(1);
  flush();
  expect(top).toBe(1100);
  expect(observers[0].targets).toEqual(
    new Set([screen.getByTestId("viewport"), screen.getByTestId("transcript")]),
  );
});

// @lat: [[chat-performance#Bottom follow ownership#Reading earlier output and explicit return]]
it("preserves intentional upward scrolling through growth and resumes when explicitly returning", () => {
  mount();
  top = 100;
  fireEvent.scroll(screen.getByTestId("viewport"));
  height = 1300;
  resize();
  flush();
  expect(top).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  flush();
  expect(top).toBe(1000);
  height = 1500;
  resize();
  flush();
  expect(top).toBe(1200);
});

// @lat: [[chat-performance#Bottom follow ownership#Native bottom re-entry]]
it("resumes when the reader scrolls back to the bottom", () => {
  mount();
  top = 20;
  fireEvent.scroll(screen.getByTestId("viewport"));
  top = 400;
  fireEvent.scroll(screen.getByTestId("viewport"));
  height = 1000;
  resize();
  flush();
  expect(top).toBe(700);
});

// @lat: [[chat-performance#Bottom follow ownership#Scope and unmount cleanup]]
it("cancels old scope work and disconnects observers on scope replacement and unmount", () => {
  const view = mount();
  const old = observers[0];
  height = 1200;
  resize();
  expect(frames.size).toBe(1);
  view.rerender(<Harness scope="different-conversation" />);
  expect(old.disconnected).toBe(true);
  flush();
  expect(top).toBe(900);
  height = 1500;
  resize();
  view.unmount();
  expect(observers.every((o) => o.disconnected)).toBe(true);
  expect(frames.size).toBe(0);
  resize();
  flush();
  expect(top).toBe(900);
});

// @lat: [[chat-performance#Bottom follow ownership#Upward input cancels queued follow]]
it("lets upward wheel input cancel a queued following frame before scroll geometry changes", () => {
  mount();
  height = 1100;
  resize();
  fireEvent.wheel(screen.getByTestId("viewport"), { deltaY: -30 });
  flush();
  expect(top).toBe(400);
  expect(
    screen.getByRole("button", { name: "Jump to latest" }),
  ).toBeInTheDocument();
});

// @lat: [[chat-performance#Bottom follow ownership#New user turn resumes following]]
it("resumes following for a newly submitted user row after reading earlier content", () => {
  const view = mount();
  top = 50;
  fireEvent.scroll(screen.getByTestId("viewport"));
  height = 1100;
  view.rerender(
    <Harness
      rows={[
        ...messages,
        { id: "next-user", role: "user", content: "Next prompt" },
      ]}
    />,
  );
  flush();
  expect(top).toBe(800);
  expect(
    screen.queryByRole("button", { name: "Jump to latest" }),
  ).not.toBeInTheDocument();
});

// @lat: [[chat-performance#Bottom follow ownership#Small upward gesture remains paused]]
it.each([true, false])(
  "keeps small upward intent paused inside the bottom tolerance (wheel=%s)",
  (wheel) => {
    mount();
    const viewport = screen.getByTestId("viewport");
    if (wheel) fireEvent.wheel(viewport, { deltaY: -10 });
    top = 390;
    fireEvent.scroll(viewport);
    height = 1100;
    resize();
    flush();
    expect(top).toBe(390);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    top = 790;
    fireEvent.scroll(viewport);
    height = 1300;
    resize();
    flush();
    expect(top).toBe(1000);
  },
);

// @lat: [[chat-performance#Bottom follow ownership#Editing keys remain with their editor]]
it.each([
  "input",
  "textarea",
  "select",
  "contenteditable",
  "nested-contenteditable",
])("does not pause following for navigation keys inside %s", (kind) => {
  mount();
  const viewport = screen.getByTestId("viewport");
  const editor = document.createElement(
    kind.includes("contenteditable") ? "div" : kind,
  );
  if (kind.includes("contenteditable"))
    editor.setAttribute("contenteditable", "true");
  const target =
    kind === "nested-contenteditable"
      ? editor.appendChild(document.createElement("span"))
      : editor;
  viewport.appendChild(editor);
  for (const key of ["ArrowUp", "PageUp", "Home", " "])
    fireEvent.keyDown(target, { key, shiftKey: key === " " });
  height = 1100;
  resize();
  flush();
  expect(top).toBe(800);
  expect(
    screen.queryByRole("button", { name: "Jump to latest" }),
  ).not.toBeInTheDocument();
});

// @lat: [[chat-performance#Bottom follow ownership#Nonediting navigation still pauses]]
it("retains upward navigation pause outside editing fields", () => {
  mount();
  fireEvent.keyDown(screen.getByTestId("viewport"), { key: "Home" });
  height = 1100;
  resize();
  flush();
  expect(top).toBe(400);
  expect(
    screen.getByRole("button", { name: "Jump to latest" }),
  ).toBeInTheDocument();
});

// @lat: [[chat-performance#Bottom follow ownership#Native bottom clamp retains following]]
it.each([0, 0.5])(
  "keeps following when native layout clamps the viewport at its actual bottom (rounding=%s)",
  (rounding) => {
    mount();
    height = 650;
    top = 350 - rounding;
    fireEvent.scroll(screen.getByTestId("viewport"));
    height = 1100;
    resize();
    flush();
    expect(top).toBe(800);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  },
);
