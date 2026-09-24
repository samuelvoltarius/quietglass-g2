# Even Hub SDK — verified capability matrix

**SDK inspected:** `@evenrealities/even_hub_sdk@0.0.16` (latest on npm at time of writing)
**Method:** read from the shipped `dist/index.d.ts`, not from memory or documentation prose.
**Date:** 2026-09-24

Every Aigner Labs app targets this version. Nothing in this file is inferred — if an API
is not listed under "Available", it does not exist in the SDK surface.

---

## Available

### Device & identity
| API | Signature |
|---|---|
| `getUserInfo()` | `Promise<UserInfo>` |
| `getDeviceInfo()` | `Promise<DeviceInfo \| null>` |
| `onDeviceStatusChanged(cb)` | wearing / battery / charging / in-case / connect type |
| `onLaunchSource(cb)` | `'appMenu' \| 'glassesMenu'` |

### Storage (per app, on the phone)
| API | Signature |
|---|---|
| `setLocalStorage(key, value)` | `Promise<boolean>` |
| `getLocalStorage(key)` | `Promise<string>` |

Strings only. All app configuration is JSON-encoded into these.

### Location — **available**
| API | Signature |
|---|---|
| `getAppLocation(options?)` | `Promise<AppLocation \| null>` |
| `startAppLocationUpdates(options?)` | `Promise<boolean>` |
| `stopAppLocationUpdates()` | `Promise<boolean>` |
| `onAppLocationChanged(cb)` | push updates |

```ts
interface AppLocation {
  latitude: number; longitude: number;
  accuracy?: number; altitude?: number;
  speed?: number; heading?: number; timestamp?: number;
}
interface AppLocationOptions {
  accuracy?: 'low' | 'medium' | 'high';
  timeoutMs?: number; distanceFilter?: number; intervalMs?: number;
}
```

Position comes from the **phone**, not the glasses. `speed` and `heading` are supplied,
which is enough for turn-by-turn navigation without dead reckoning.

### Microphone — **available, source selectable**
| API | Signature |
|---|---|
| `audioControl(isOpen, source?)` | `Promise<boolean>` |

```ts
enum AudioInputSource { Glasses = 'glasses', Phone = 'phone' }
```

Requires a successful `createStartUpPageContainer()` first. PCM arrives through
`onEvenHubEvent` as `event.audioEvent.audioPcm: Uint8Array`.

### IMU (head motion)
| API | Signature |
|---|---|
| `imuControl(isOpen, reportFrq?)` | `ImuReportPace.P100 … P1000` (ms) |

### Camera / album — phone-side, user-initiated
| API | Signature |
|---|---|
| `pickImageFromAlbum()` | `Promise<AppImageAsset \| null>` |
| `captureImageFromCamera()` | `Promise<AppImageAsset \| null>` |

The **glasses have no camera**. These open the phone's picker/camera and return
`{ path, name, mimeType, size, base64 }`.

### Display containers
| API | Purpose |
|---|---|
| `createStartUpPageContainer(c)` | build a page — returns `Success \| Invalid \| Oversize \| OutOfMemory` |
| `rebuildPageContainer(c)` | rebuild a page (see hardware caveat below) |
| `textContainerUpgrade(c)` | change text without rebuilding — the fast path |
| `updateImageRawData(d)` | push image pixels |
| `shutDownPageContainer(exitMode?)` | leave the app |

Container kinds: **Text**, **List**, **Image**, **Menu** *(Menu is new in 0.0.16)*.

### Events
```ts
enum EvenHubEventType {
  listEvent, textEvent, sysEvent, audioEvent, menuItemClickEvent, notSet
}
enum EventSourceType {
  TOUCH_EVENT_FORM_DUMMY_NULL = 0,
  TOUCH_EVENT_FROM_GLASSES_R  = 1,
  TOUCH_EVENT_FROM_RING       = 2,   // R1 ring is distinguishable
  TOUCH_EVENT_FROM_GLASSES_L  = 3,
}
```

Gestures: `CLICK 0`, `SCROLL_TOP 1`, `SCROLL_BOTTOM 2`, `DOUBLE_CLICK 3`,
`LONG_PRESS 9`, `LONG_PRESS_RELEASE 10`.

---

## Hard limits (enforced by the SDK's own validators)

| Limit | Value | Source |
|---|---|---|
| Display | 576 × 288 | device |
| Menu items | **max 10** | `validateEvenHubPageContainerMenu` |
| Menu item ID | must be **non-zero**, unique | `isValidMenuItemID` |
| Text brightness | `0 … 4` | `MIN/MAX_TEXT_BRIGHTNESS` |
| `zOrderIndex` | required, unique per container | `validateEvenHubPageContainerZOrder` |
| Event capture | **exactly one** container may capture input | SDK |

Use `validateEvenHubPageContainer()` before sending a page — it catches all of the above
and `formatEvenHubPageContainerValidationError()` renders the reason.

---

## NOT available — do not design around these

| Wanted | Status | Consequence |
|---|---|---|
| **Phone notifications** | **No API** | App 5 was changed to Quick Notes; no app relies on this |
| Bluetooth state | No API | Context HUD cannot use BT as a signal |
| Phone/call state | No API | ditto |
| Calendar access | No API | calendar context needs an external feed |
| Speaker / audio output | **No hardware** | feedback must be visual |
| Glasses camera | **No hardware** | phone camera only, user-initiated |
| Free pixel drawing | Not in Hub SDK | image containers only |
| Font size / alignment control | Not exposed | layout via container geometry |
| Programmatic scroll position | Not exposed | cannot drive a list from code |

---

## Verified pitfall: proto3 omits default values

**Measured by Aigner Labs in the Even Hub simulator, 2026-09-25.**

A tap on the touchpad arrives as exactly this:

```json
{"jsonData":{"eventSource":1},"sysEvent":{"eventSource":1}}
```

There is **no `eventType` field at all**. The payload is protobuf-derived, and
proto3 omits any field holding its default value. `CLICK_EVENT` is `0`, so the
most common gesture in the entire SDK arrives as an *absence*.

Consequences for any G2 app:

- **A missing `eventType` means CLICK.** Treating `undefined` as "unknown
  gesture" makes the app ignore every single tap while still receiving events.
  This is silent: the event arrives, the app just does nothing.
- The same applies to every other zero-valued field. `currentSelectItemIndex`
  is absent for list row 0, and `eventSource` is absent for
  `TOUCH_EVENT_FORM_DUMMY_NULL`.
- Read these fields as `value ?? 0`, never as `value ?? somethingElse`.

Aigner Labs apps resolve this in `input/gestures.ts`, with a regression test
that feeds in the exact payload above.

## Real-hardware caveats (community-reported, NOT yet verified by Aigner Labs)

Source: `cc-g2/docs/known-limitations.md`, corroborated by `pong-even-g2` and
`nickustinov/even-g2-notes`. **Flagged as unverified until measured on our own G2.**

1. **`rebuildPageContainer()` always fails on real glasses** → fallback to
   `createStartUpPageContainer()` costs **~3 s per screen change**, and input during
   that window is discarded. The simulator does not reproduce this.
   → *Design rule: avoid screen changes. Prefer `textContainerUpgrade()`.*
2. **Swipe direction is inverted on hardware** (`SCROLL_TOP` fires on a physical
   swipe **down**). Not reproducible in the simulator.
3. **`SCROLL_TOP`/`SCROLL_BOTTOM` fire only at list boundaries**, not per scroll step.
4. `rebuildPageContainer()` must still be *called* even though it fails — the call
   registers hardware event routing as a side effect.

These drive the shared UI rule used by every Aigner Labs app:
**one screen, updated in place — never a multi-step dialog.**
