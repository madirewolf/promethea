import type { ComponentType } from "react";
import { closeDialog, useStore } from "../store/store";
import type { DialogSpec } from "../store/store";
import { AboutDialog } from "./AboutDialog";
import { AddLinksDialog } from "./AddLinksDialog";
import { AddTorrentHost } from "./AddTorrentDialog";
import { CategoryDialog } from "./CategoryDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { CreatorDialog } from "./CreatorDialog";
import { DeleteDialog } from "./DeleteDialog";
import { GlobalLimitsDialog } from "./GlobalLimitsDialog";
import { LocationDialog } from "./LocationDialog";
import { OptionsDialog } from "./OptionsDialog";
import { PromptDialog } from "./PromptDialog";
import { RenameDialog } from "./RenameDialog";
import { TagDialog } from "./TagDialog";
import { RulesDialog } from "../views/rss/RulesDialog";
import { OfficialPluginsDialog, SearchErrorsDialog, SearchPluginsDialog } from "../views/search/PluginsDialog";

export interface DialogProps<S extends DialogSpec = DialogSpec> {
  spec: S;
  close: () => void;
}

/** Every dialog `openDialog({ type })` can show. */
const DIALOGS: Record<string, ComponentType<DialogProps<any>>> = {
  confirm: ConfirmDialog,
  prompt: PromptDialog,
  delete: DeleteDialog,
  addLinks: AddLinksDialog,
  location: LocationDialog,
  rename: RenameDialog,
  options: OptionsDialog,
  category: CategoryDialog,
  newTag: TagDialog,
  globalLimits: GlobalLimitsDialog,
  about: AboutDialog,
  creator: CreatorDialog,
  searchPlugins: SearchPluginsDialog,
  officialPlugins: OfficialPluginsDialog,
  searchErrors: SearchErrorsDialog,
  rssRules: RulesDialog,
};

export function DialogHost() {
  const dialogs = useStore((s) => s.dialogs);
  return (
    <>
      {/* Below the other dialogs, so a confirmation opened from it shows on top. */}
      <AddTorrentHost />
      {dialogs.map((d) => {
        const Dialog = DIALOGS[d.spec.type];
        if (!Dialog) {
          console.warn("unknown dialog", d.spec.type);
          return null;
        }
        return <Dialog key={d.id} spec={d.spec} close={() => closeDialog(d.id)} />;
      })}
    </>
  );
}
