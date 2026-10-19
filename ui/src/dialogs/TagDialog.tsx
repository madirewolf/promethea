import { Tag } from "lucide-react";
import { api } from "../api/client";
import { plural } from "../lib/format";
import { useStore } from "../store/store";
import type { DialogProps } from "./DialogHost";
import { PromptDialog } from "./PromptDialog";
import type { PromptSpec } from "./PromptDialog";

export interface TagSpec {
  type: "newTag";
  /** Torrents that get the new tags. */
  assignTo?: string[];
}

const split = (v: string) => [...new Set(v.split(",").map((t) => t.trim()).filter(Boolean))];

/** Create tags (comma separated), optionally adding them to torrents right away. */
export function TagDialog({ spec, close }: DialogProps<TagSpec>) {
  const assign = spec.assignTo?.length ?? 0;
  const prompt: PromptSpec = {
    type: "prompt",
    title: assign ? "Add a new tag" : "New tag",
    subtitle: assign ? `To ${assign === 1 ? "the selected torrent" : plural(assign, "selected torrent")}` : undefined,
    icon: <Tag />,
    label: "Tag",
    placeholder: "e.g. linux, keep",
    confirmLabel: assign ? "Add" : "Create",
    hint: "Separate several tags with commas.",
    validate: (v) => {
      const tags = split(v);
      if (!tags.length) return "Enter a tag";
      const have = new Set(useStore.getState().tags);
      if (!assign && tags.every((t) => have.has(t))) return tags.length > 1 ? "Those tags already exist" : "That tag already exists";
      return null;
    },
    onSubmit: async (v) => {
      const tags = split(v);
      await api.createTags(tags);
      if (assign) await api.set(spec.assignTo!, { tags: { tags, mode: "add" } });
    },
  };
  return <PromptDialog spec={prompt} close={close} />;
}
