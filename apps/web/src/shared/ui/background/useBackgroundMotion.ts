import { useEffect, useState } from "react";

export function useBackgroundMotion(): { visible: boolean; reduced: boolean } {
  const read = () => ({ visible: !document.hidden, reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches });
  const [state, setState] = useState(read);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setState(read());
    document.addEventListener("visibilitychange", update);
    query.addEventListener("change", update);
    update();
    return () => { document.removeEventListener("visibilitychange", update); query.removeEventListener("change", update); };
  }, []);
  return state;
}
