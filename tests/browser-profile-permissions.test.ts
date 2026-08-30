import test from "node:test";
import assert from "node:assert/strict";

function installBrowserGlobals() {
  const storage = new Map<string, string>();
  const navigator = { language: "en-US", userAgent: "node-test" };
  const localStorage = {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: navigator,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight: 900,
      innerWidth: 1440,
      localStorage,
      navigator,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
      termcanvas: undefined,
    },
  });
}

/** The stores are module singletons; every test starts from a known registry. */
async function freshCanvases(ids: string[]) {
  const registry = await import("../src/stores/canvasRegistryStore.ts");
  const scene = registry.useCanvasRegistryStore.getState().canvases[0].scene;
  registry.useCanvasRegistryStore.getState().hydrate(
    ids.map((id, index) => ({
      id,
      name: `Canvas ${index + 1}`,
      createdAt: index + 1,
      scene,
    })),
    ids[0],
  );
  return { ...registry, scene };
}

async function freshIdentities() {
  const { useIdentityStore } = await import("../src/stores/identityStore.ts");
  useIdentityStore
    .getState()
    .hydrate(
      [{ id: "identity-default", name: "Guest", createdAt: 1 }],
      "identity-default",
    );
  return useIdentityStore;
}

// ---------------------------------------------------------------- colours

test("a profile's colour is derived from its id, and Guest has none", async () => {
  const { profileHue, profileSwatch, isGuestProfile } = await import(
    "../src/browser/profileColor.ts"
  );
  const { GUEST_PROFILE_ID } = await import(
    "../shared/browser-agent-profiles.ts"
  );

  // Stable: the chip must not change colour between renders, or after a
  // rename — the id is the only input.
  assert.equal(profileHue("identity-abc-1"), profileHue("identity-abc-1"));
  assert.equal(
    profileSwatch("identity-abc-1").color,
    profileSwatch("identity-abc-1").color,
  );

  assert.equal(isGuestProfile(GUEST_PROFILE_ID), true);
  assert.equal(profileHue(GUEST_PROFILE_ID), null);
  const guest = profileSwatch(GUEST_PROFILE_ID);
  assert.equal(guest.hue, null);
  assert.equal(guest.color, "var(--text-faint)");
  assert.equal(guest.soft, "transparent");
});

test("ids that differ by one character get visibly different hues", async () => {
  const { profileHue } = await import("../src/browser/profileColor.ts");

  // Generated ids are `identity-<base36>-<n>`, so profiles made seconds apart
  // differ only in their last characters. If those landed on neighbouring
  // hues the whole point — telling nodes apart at canvas zoom — would be lost.
  const hues = ["identity-m1x2y-1", "identity-m1x2y-2", "identity-m1x2y-3"].map(
    (id) => profileHue(id),
  );
  for (const hue of hues) {
    assert.ok(hue !== null && hue >= 0 && hue < 360, `hue out of range: ${hue}`);
  }
  assert.equal(new Set(hues).size, 3);
  for (let i = 0; i < hues.length; i += 1) {
    for (let j = i + 1; j < hues.length; j += 1) {
      const raw = Math.abs((hues[i] as number) - (hues[j] as number));
      const separation = Math.min(raw, 360 - raw);
      assert.ok(separation > 20, `hues too close: ${hues[i]} vs ${hues[j]}`);
    }
  }
});

// ------------------------------------------------- the global agent toggle

test("profiles arrive allowed, and only an explicit withholding turns agents off", async () => {
  installBrowserGlobals();
  const useIdentityStore = await freshIdentities();
  const { useWorkspaceStore } = await import("../src/stores/workspaceStore.ts");
  const { isAgentAllowed } = await import("../src/types/workspace.ts");

  const id = useIdentityStore.getState().createIdentity("Work");
  // Deliberate product decision: on by default. A first agent browser task
  // hitting a permission wall is the worse failure; the mitigation is where
  // the toggle sits — on the import result row — not the default.
  assert.equal(isAgentAllowed(useIdentityStore.getState().identities[id]), true);
  assert.equal(
    useIdentityStore.getState().identities[id].agentAllowed,
    undefined,
  );

  useWorkspaceStore.setState({ dirty: false });
  useIdentityStore.getState().setAgentAllowed(id, false);
  assert.equal(useIdentityStore.getState().identities[id].agentAllowed, false);
  assert.equal(isAgentAllowed(useIdentityStore.getState().identities[id]), false);
  // Withholding has to survive a save, or the permission lasts until restart.
  assert.equal(useWorkspaceStore.getState().dirty, true);

  useWorkspaceStore.setState({ dirty: false });
  useIdentityStore.getState().setAgentAllowed(id, true);
  assert.equal(isAgentAllowed(useIdentityStore.getState().identities[id]), true);
  assert.equal(useWorkspaceStore.getState().dirty, true);

  // Setting what is already set is not a change, and must not dirty the
  // workspace every time the toggle renders.
  useWorkspaceStore.setState({ dirty: false });
  useIdentityStore.getState().setAgentAllowed(id, true);
  assert.equal(useWorkspaceStore.getState().dirty, false);

  useIdentityStore.getState().setAgentAllowed("identity-does-not-exist", false);
  assert.equal(useWorkspaceStore.getState().dirty, false);
});

test("a withheld profile reaches the resolver as withheld", async () => {
  installBrowserGlobals();
  const useIdentityStore = await freshIdentities();
  const { isAgentAllowed } = await import("../src/types/workspace.ts");
  const { mayAgentUseProfile } = await import(
    "../shared/browser-agent-profiles.ts"
  );

  const id = useIdentityStore.getState().createIdentity("Banking");
  useIdentityStore.getState().setAgentAllowed(id, false);
  const candidates = Object.values(useIdentityStore.getState().identities).map(
    (identity) => ({
      id: identity.id,
      name: identity.name,
      agentAllowed: isAgentAllowed(identity),
    }),
  );
  assert.equal(mayAgentUseProfile(id, candidates), false);
  assert.equal(mayAgentUseProfile("identity-default", candidates), true);
});

// ------------------------------------------------- the per-canvas default

test("a canvas default is absent, then answered, and dismissal is an answer", async () => {
  installBrowserGlobals();
  const { useCanvasRegistryStore, getAgentDefaultIdentityId } =
    await freshCanvases(["canvas-one"]);
  const { useWorkspaceStore } = await import("../src/stores/workspaceStore.ts");

  const canvasOf = () =>
    useCanvasRegistryStore
      .getState()
      .canvases.find((c) => c.id === "canvas-one")!;

  // Never asked: the key is not there at all. This is the only state that
  // makes the prompt appear.
  assert.equal("agentDefaultIdentityId" in canvasOf(), false);
  assert.equal(getAgentDefaultIdentityId("canvas-one"), undefined);

  useWorkspaceStore.setState({ dirty: false });
  useCanvasRegistryStore
    .getState()
    .setAgentDefaultIdentity("canvas-one", "identity-work");
  assert.equal(getAgentDefaultIdentityId("canvas-one"), "identity-work");
  assert.equal(useWorkspaceStore.getState().dirty, true);

  // Dismissed: present and null. Collapsing this into "absent" would re-ask
  // the same question at every agent action.
  useCanvasRegistryStore.getState().setAgentDefaultIdentity("canvas-one", null);
  assert.equal("agentDefaultIdentityId" in canvasOf(), true);
  assert.equal(canvasOf().agentDefaultIdentityId, null);
  assert.equal(getAgentDefaultIdentityId("canvas-one"), null);

  useCanvasRegistryStore
    .getState()
    .setAgentDefaultIdentity("canvas-missing", "identity-work");
  assert.equal(getAgentDefaultIdentityId("canvas-one"), null);
});

test("absent, null, and a chosen id all survive a snapshot round trip", async () => {
  installBrowserGlobals();
  const { scene } = await freshCanvases(["canvas-seed"]);
  const { readWorkspaceSnapshot } = await import("../src/snapshotBridge.ts");

  const document = {
    version: 3,
    activeCanvasId: "canvas-a",
    canvases: [
      { id: "canvas-a", name: "Never asked", createdAt: 1, scene },
      {
        id: "canvas-b",
        name: "Dismissed",
        createdAt: 2,
        scene,
        agentDefaultIdentityId: null,
      },
      {
        id: "canvas-c",
        name: "Answered",
        createdAt: 3,
        scene,
        agentDefaultIdentityId: "identity-default",
      },
    ],
    identities: [
      { id: "identity-default", name: "Guest", createdAt: 1 },
      { id: "identity-work", name: "Work", createdAt: 2, agentAllowed: false },
    ],
    activeIdentityId: "identity-default",
  };

  const restored = readWorkspaceSnapshot(JSON.parse(JSON.stringify(document)));
  assert.ok(restored && "workspace" in restored && restored.workspace);
  const canvases = restored.workspace!.canvases;
  const byId = (id: string) => canvases.find((c) => c.id === id)!;

  assert.equal("agentDefaultIdentityId" in byId("canvas-a"), false);
  assert.equal("agentDefaultIdentityId" in byId("canvas-b"), true);
  assert.equal(byId("canvas-b").agentDefaultIdentityId, null);
  assert.equal(byId("canvas-c").agentDefaultIdentityId, "identity-default");

  const identities = restored.workspace!.identities;
  assert.equal(
    identities.find((i) => i.id === "identity-work")!.agentAllowed,
    false,
  );
  // Allowed is stored as absence, which `isAgentAllowed` reads as allowed —
  // the same meaning, and what workspaces from before this feature look like.
  assert.equal(
    identities.find((i) => i.id === "identity-default")!.agentAllowed,
    undefined,
  );
});

test("the prompt writes the canvas's answer, and dismissing writes null", async () => {
  installBrowserGlobals();
  const { getAgentDefaultIdentityId } = await freshCanvases([
    "canvas-prompt",
    "canvas-other",
  ]);
  const { useAgentProfilePromptStore, canvasDefaultUnanswered } = await import(
    "../src/stores/agentProfilePromptStore.ts"
  );

  assert.equal(canvasDefaultUnanswered("canvas-prompt"), true);

  // Nothing to answer for a canvas that does not exist.
  useAgentProfilePromptStore.getState().requestCanvasDefault("canvas-missing");
  assert.equal(useAgentProfilePromptStore.getState().canvasId, null);

  // No argument means the canvas the user is looking at.
  useAgentProfilePromptStore.getState().requestCanvasDefault();
  assert.equal(
    useAgentProfilePromptStore.getState().canvasId,
    "canvas-prompt",
  );

  useAgentProfilePromptStore.getState().choose("identity-work");
  assert.equal(useAgentProfilePromptStore.getState().canvasId, null);
  assert.equal(getAgentDefaultIdentityId("canvas-prompt"), "identity-work");
  assert.equal(canvasDefaultUnanswered("canvas-prompt"), false);
  // The answer is this canvas's alone.
  assert.equal(getAgentDefaultIdentityId("canvas-other"), undefined);

  useAgentProfilePromptStore.getState().requestCanvasDefault("canvas-prompt");
  useAgentProfilePromptStore.getState().dismiss();
  assert.equal(useAgentProfilePromptStore.getState().canvasId, null);
  assert.equal(getAgentDefaultIdentityId("canvas-prompt"), null);
  // Dismissed is answered: the prompt does not come back on its own.
  assert.equal(canvasDefaultUnanswered("canvas-prompt"), false);

  // Choosing with nothing open must not touch a canvas.
  useAgentProfilePromptStore.getState().choose("identity-other");
  assert.equal(getAgentDefaultIdentityId("canvas-prompt"), null);
});
