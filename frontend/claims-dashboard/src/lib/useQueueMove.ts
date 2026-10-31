import { useCallback } from "react";
import { useAppStore } from "../store/useAppStore";
import { useToast } from "../store/useToast";
import type { ClaimQueue } from "../types";
import { queueLabel } from "./format";

/** Moves a claim between queues, confirms with a toast, and offers Undo. */
export function useQueueMove() {
  const moveQueue = useAppStore((s) => s.moveQueue);
  const push = useToast((s) => s.push);

  return useCallback(
    (claimId: string, queue: ClaimQueue, reason?: string) => {
      const previous = moveQueue(claimId, queue, reason);
      push({
        tone: "success",
        message: `${claimId} saved as “${queueLabel[queue]}”.`,
        action:
          previous && previous !== queue
            ? {
                label: "Undo",
                onClick: () => {
                  moveQueue(claimId, previous, `Undo: restored ${previous}`);
                  push({
                    tone: "info",
                    message: `${claimId} restored to “${queueLabel[previous]}”.`,
                  });
                },
              }
            : undefined,
      });
    },
    [moveQueue, push],
  );
}
