import { useEffect } from "react";
import { useProjectStore } from "../stores/projectStore";
import { usePinStore } from "../stores/pinStore";

export function usePinPreloader() {
  const projectCount = useProjectStore((s) => s.projects.length);

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
}
