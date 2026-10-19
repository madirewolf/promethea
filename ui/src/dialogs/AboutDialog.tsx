import { Copy } from "lucide-react";
import { BrandLogo } from "../components/shell/Sidebar";
import { Button, IconButton } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { copyText } from "../lib/actions";
import { useStore } from "../store/store";
import type { DialogProps } from "./DialogHost";

export interface AboutSpec {
  type: "about";
}

const PLATFORMS: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

export function AboutDialog({ close }: DialogProps<AboutSpec>) {
  const app = useStore((s) => s.app);
  if (!app) return null;
  const details = [
    `Promethea ${app.version}`,
    `libtorrent ${app.libtorrent}`,
    `Python ${app.python}`,
    PLATFORMS[app.platform] ?? app.platform,
  ].join("\n");
  return (
    <Modal
      title={
        <span className="about-title">
          <BrandLogo />
          Promethea
        </span>
      }
      subtitle="A fast, uncluttered BitTorrent client."
      size="sm"
      onClose={close}
      footer={
        <>
          <span className="spacer" />
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        </>
      }
    >
      <dl className="kv about-kv">
        <dt>Version</dt>
        <dd>{app.version}</dd>
        <dt>Engine</dt>
        <dd>libtorrent {app.libtorrent}</dd>
        <dt>Python</dt>
        <dd>{app.python}</dd>
        <dt>System</dt>
        <dd>{PLATFORMS[app.platform] ?? app.platform}</dd>
        {app.dataDir && (
          <>
            <dt>Data folder</dt>
            <dd className="mono selectable">{app.dataDir}</dd>
          </>
        )}
      </dl>
      <div className="row about-copy">
        <IconButton label="Copy version details" size="sm" onClick={() => void copyText(details, "Version details")}>
          <Copy />
        </IconButton>
        <span className="faint">Copy version details for a bug report</span>
      </div>
    </Modal>
  );
}
