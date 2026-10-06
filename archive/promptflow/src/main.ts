import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { parseScript } from "./script/parse";
import { layoutScript, type DisplayLine } from "./prompter/layout";
import { initialPrompterState, setMode, tick, totalWords, type PrompterState } from "./prompter/engine";
import { dispatch } from "./input/dispatch";
import { gestureFromEvent } from "./input/gestures";
import { buildView, textWidth, type PrompterView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { activeScript, load, save, type PromptFlowData } from "./storage/persist";
import { EMPTY_SCRIPT, type Script } from "./script/model";
import { mountPhoneUi } from "./ui/phone";

/** How often the scroll position is recomputed. */
const TICK_MS = 200;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: PromptFlowData = await load(bridge);
  let script: Script = EMPTY_SCRIPT;
  let lines: readonly DisplayLine[] = [];
  let state: PrompterState = initialPrompterState(data.settings.mode);
  let lastView: PrompterView | null = null;
  let pageReady = false;
  /** Set once the user leaves; nothing may be drawn on a closed page. */
  let closed = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  const relayout = (): void => {
    lines = layoutScript(script, {
      maxWidth: textWidth(data.settings.lineWidth, data.settings.showCursor),
    });
  };

  const reloadScript = (): void => {
    const stored = activeScript(data);
    script = stored
      ? parseScript(stored.source, { fallbackTitle: stored.title })
      : EMPTY_SCRIPT;
    relayout();
    state = setMode(initialPrompterState(data.settings.mode), data.settings.mode);
    state = { ...state, wpm: data.settings.wpm };
    lastView = null;
  };

  /**
   * Applies data saved on the phone. Only a different script starts over:
   * adjusting a display setting mid-talk must not throw the reader back to
   * the first line.
   */
  const applyData = (previous: PromptFlowData, next: PromptFlowData): void => {
    const before = activeScript(previous);
    const after = activeScript(next);
    const sameScript = before?.id === after?.id
      && before?.source === after?.source
      && before?.title === after?.title;
    if (!sameScript) { reloadScript(); return; }

    // Position is counted in words, so it survives re-wrapping unchanged.
    relayout();
    state = { ...state, wordsRead: Math.min(state.wordsRead, totalWords(lines)) };
    if (previous.settings.mode !== next.settings.mode) {
      state = { ...setMode(state, next.settings.mode), wpm: next.settings.wpm };
    } else if (previous.settings.wpm !== next.settings.wpm) {
      state = { ...state, wpm: next.settings.wpm };
    }
    lastView = null;
  };

  const currentView = (): PrompterView =>
    buildView(script, lines, state, {
      visibleLines: data.settings.visibleLines,
      showCursor: data.settings.showCursor,
    });

  const drawOnce = async (): Promise<void> => {
    const view = currentView();
    if (sameView(lastView, view)) return;

    const result = pageReady
      ? await updatePage(bridge, view)
      : await createPage(bridge, view);

    if (result.ok) {
      pageReady = true;
      lastView = view;
      return;
    }
    // A failed update usually means the page is gone (app relaunched, glasses
    // reconnected). Rebuild it on the next draw rather than going silent.
    pageReady = false;
    lastView = null;
    console.warn("[promptflow] draw failed:", result.reason);
  };

  /**
   * One draw at a time. The tick, gestures and the phone all request redraws;
   * interleaving them would race two page creations, or let an older view
   * land after a newer one. Requests made meanwhile collapse into one redraw.
   */
  const draw = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do {
          redrawQueued = false;
          await drawOnce();
        } while (redrawQueued && !closed);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  reloadScript();
  await draw();

  let ticker: ReturnType<typeof setInterval> | undefined;

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(ticker);
    bridge.shutDownPageContainer().catch((error: unknown) => {
      console.warn("[promptflow] shutdown failed:", error);
    });
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const gesture = gestureFromEvent(event, { invertScroll: data.settings.invertScroll });
    if (!gesture) return;

    const result = dispatch(state, gesture.gesture, { script, lines });
    state = result.state;

    for (const effect of result.effects) {
      if (effect.kind === "exit") {
        close();
        return;
      }
    }
    void draw();
  });

  // Rebuilding on reconnect: the page does not survive a disconnect. The last
  // view is forgotten too, or an unchanged view would skip the rebuild.
  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected") {
      pageReady = false;
      lastView = null;
      void draw();
    }
  });

  let last = Date.now();
  ticker = setInterval(() => {
    const now = Date.now();
    const elapsed = now - last;
    last = now;
    if (!state.running) return;
    const next = tick(state, lines, elapsed);
    if (next === state) return;
    state = next;
    void draw();
  }, TICK_MS);

  mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      const previous = data;
      data = next;
      applyData(previous, next);
      await save(bridge, next);
      await draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[promptflow] failed to start:", error);
});
