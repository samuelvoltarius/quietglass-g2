import { describe, expect, it } from "vitest";
import { parseHaState, withRemote } from "../src/tv/ha";

// What Home Assistant reported on 27.10.: the TV in standby, the media player still "idle" with Spotify and muted.
const stalePlayer = { entity_id: "media_player.wohnzimmer", state: "idle", attributes: { friendly_name: "TV", app_name: "Spotify", is_volume_muted: true, volume_level: 0.54 } };

describe("remote decides power", () => {
  it("an off remote turns the stale player into an off TV without app or mute", () => {
    const state = withRemote(parseHaState(stalePlayer), { entity_id: "remote.wohnzimmer", state: "off" });
    expect(state.power).toBe("off");
    expect(state.app).toBeNull();
    expect(state.muted).toBeNull();
  });

  it("an on remote keeps the player's details", () => {
    const state = withRemote(parseHaState(stalePlayer), { entity_id: "remote.wohnzimmer", state: "on" });
    expect(state.power).toBe("on");
    expect(state.app).toBe("Spotify");
  });

  it("an off player with an on remote counts as on", () => {
    const state = withRemote(parseHaState({ entity_id: "media_player.x", state: "off" }), { entity_id: "remote.x", state: "on" });
    expect(state.power).toBe("on");
  });

  it("without a remote nothing changes", () => {
    expect(withRemote(parseHaState(stalePlayer), undefined).power).toBe("on");
  });
});
