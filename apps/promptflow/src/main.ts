import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { parseScript } from "./script/parse";
import { layoutScript, type DisplayLine } from "./prompter/layout";
import { initialPrompterState, setMode, tick, type PrompterState } from "./prompter/engine";
import { dispatch } from "./input/dispatch";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type PrompterView } from "./glasses/view";
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

  const reloadScript = (): void => {
    const stored = activeScript(data);
    script = stored
      ? parseScript(stored.source, { fallbackTitle: stored.title })
      : EMPTY_SCRIPT;
    lines = layoutScript(script, { maxWidth: data.settings.lineWidth });
    state = setMode(initialPrompterState(data.settings.mode), data.settings.mode);
    state = { ...state, wpm: data.settings.wpm };
    lastView = null;
  };

  const currentView = (): PrompterView =>
    buildView(script, lines, state, {
      visibleLines: data.settings.visibleLines,
      showCursor: data.settings.showCursor,
    });

  const draw = async (): Promise<void> => {
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
    console.warn("[promptflow] draw failed:", result.reason);
  };

  reloadScript();
  await draw();

  bridge.onEvenHubEvent((event) => {
    const gesture = gestureFromEvent(event, { invertScroll: data.settings.invertScroll });
    if (!gesture) return;

    const result = dispatch(state, gesture.gesture, { script, lines });
    state = result.state;

    for (const effect of result.effects) {
      if (effect.kind === "exit") {
        void bridge.shutDownPageContainer();
        return;
      }
    }
    void draw();
  });

  // Rebuilding on reconnect: the page does not survive a disconnect.
  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected") {
      pageReady = false;
      void draw();
    }
  });

  let last = Date.now();
  setInterval(() => {
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
      data = next;
      await save(bridge, next);
      reloadScript();
      await draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[promptflow] failed to start:", error);
});
