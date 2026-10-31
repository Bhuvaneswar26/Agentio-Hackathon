import { create } from "zustand";
import { uid } from "../lib/format";

export type Toast = {
  id: string;
  message: string;
  tone: "success" | "error" | "info";
  action?: { label: string; onClick: () => void };
};

type ToastState = {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">, ttlMs?: number) => void;
  dismiss: (id: string) => void;
};

export const useToast = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (toast, ttlMs = 6000) => {
    const id = uid("toast");
    set({ toasts: [...get().toasts, { ...toast, id }].slice(-4) });
    setTimeout(() => get().dismiss(id), ttlMs);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
