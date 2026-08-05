import { useEffect, useState, type DragEvent } from "react";

export function useNormalConversationDropController(input: {
  readonly blocked: boolean;
  readonly resetKey: string;
  readonly onFiles: (files: FileList) => void | Promise<void>;
}): {
  readonly active: boolean;
  readonly onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLDivElement>) => void;
} {
  const [active, setActive] = useState(false);

  useEffect(() => setActive(false), [input.resetKey]);

  return {
    active,
    onDragOver(event) {
      if (input.blocked || !Array.from(event.dataTransfer.types).includes("Files")) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setActive(true);
    },
    onDragLeave(event) {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }
      setActive(false);
    },
    onDrop(event) {
      event.preventDefault();
      setActive(false);
      if (input.blocked || event.dataTransfer.files.length === 0) {
        return;
      }
      void input.onFiles(event.dataTransfer.files);
    },
  };
}
