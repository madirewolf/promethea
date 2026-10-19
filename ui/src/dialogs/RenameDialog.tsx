import { useState } from "react";
import { Pencil } from "lucide-react";
import { api } from "../api/client";
import { useStore } from "../store/store";
import type { DialogProps } from "./DialogHost";
import { PromptDialog } from "./PromptDialog";
import type { PromptSpec } from "./PromptDialog";

export interface RenameSpec {
  type: "rename";
  id: string;
}

/** Rename a torrent (the name Promethea shows; files on disk keep theirs). */
export function RenameDialog({ spec, close }: DialogProps<RenameSpec>) {
  const [name] = useState(() => useStore.getState().torrents[spec.id]?.name ?? "");
  const prompt: PromptSpec = {
    type: "prompt",
    title: "Rename torrent",
    icon: <Pencil />,
    label: "Name",
    value: name,
    size: "md",
    confirmLabel: "Rename",
    hint: "Only the name in the list changes. To rename files or folders on disk, use the Files tab.",
    validate: (v) => (v.trim() ? null : "The name can't be empty"),
    onSubmit: async (v) => {
      if (v.trim() !== name) await api.rename(spec.id, v.trim());
    },
  };
  return <PromptDialog spec={prompt} close={close} />;
}
