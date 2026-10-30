import { useEffect } from "react";
import { useProjectStore } from "../stores/projectStore";
import { usePinStore } from "../stores/pinStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";

export function usePinPreloader() {
  const projectCount = useProjectStore((s) => s.projects.length);
  // Every other workdesk's folders, so the Hub can say which of them has a
  // task waiting on you without you opening each one first.
  const otherFolders = useCanvasRegistryStore((s) =>
    s.canvases
      .filter((c) => c.id !== s.activeCanvasId)
      .flatMap((c) => c.scene.projects.map((p) => p.path))
      .sort()
      .join("\n"),
  );

  useEffect(() => {
    if (!window.tacit || projectCount === 0) return;

    const { projects } = useProjectStore.getState();
    const { setPins } = usePinStore.getState();

    for (const project of projects) {
      window.tacit.pins
        .list(project.path)
        .then((pins) => setPins(project.path, pins))
        .catch(() => {});
    }
  }, [projectCount]);

  useEffect(() => {
    if (!window.tacit || !otherFolders) return;
    const { pinsByProject, setPins } = usePinStore.getState();
    // Once each: pin events keep a loaded folder current after that.
    for (const path of new Set(otherFolders.split("\n"))) {
      if (pinsByProject[path]) continue;
      window.tacit.pins
        .list(path)
        .then((pins) => setPins(path, pins))
        .catch((error) => console.warn("[pins] couldn't load another workdesk's folder", path, error));
    }
  }, [otherFolders]);
}
