import { useState } from "react";
import { CircleAlert, Eye, EyeOff, Globe, Info } from "lucide-react";
import { IconButton } from "../../../components/ui/Button";
import { Input, NumberInput } from "../../../components/ui/Form";
import { useStore } from "../../../store/store";
import { Group, NumberPref, PathPref, Row, Section, SwitchPref, TextPref } from "../controls";
import { usePref } from "../draft";

const W = "webui";
const LOCAL_ONLY = "Can only be changed on the computer Promethea runs on.";

function AddressRow({ local }: { local: boolean }) {
  const [address, setAddress, addressDirty] = usePref<string>(W, "address");
  const [port, setPort, portDirty] = usePref<number>(W, "port");
  const [https] = usePref<boolean>(W, "https");
  const any = ["", "*", "0.0.0.0", "::"].includes((address ?? "").trim());
  const url = `${https ? "https" : "http"}://${any ? "<this computer's IP address>" : address.trim()}:${port}`;
  return (
    <Row
      label="Address and port"
      hint={local ? (any ? `Listens on every network. Open ${url} on another device.` : `Open ${url} on another device.`) : LOCAL_ONLY}
      keywords="listen bind host ip"
      dirty={addressDirty || portDirty}
      disabled={!local}
      sub
    >
      <div className="set-pair">
        <Input
          className="set-in mono"
          value={address ?? ""}
          placeholder="0.0.0.0"
          disabled={!local}
          onChange={(e) => setAddress(e.target.value)}
          aria-label="Address"
        />
        <NumberInput
          className="set-num-sm"
          value={port ?? 0}
          onChange={setPort}
          min={1}
          max={65535}
          disabled={!local}
          aria-label="Port"
        />
      </div>
    </Row>
  );
}

/** Write-only: the saved password never comes back, only whether there is one. */
function PasswordRow({ local }: { local: boolean }) {
  const isSet = useStore((s) => !!s.prefs?.webui?.passwordSet);
  const [password, setPassword, dirty] = usePref<string>(W, "password");
  const [show, setShow] = useState(false);
  const hint = !local
    ? LOCAL_ONLY
    : dirty
      ? "Saved as a salted hash."
      : isSet
        ? "A password is set. Type a new one to change it."
        : "Nobody can sign in until there is one.";
  return (
    <Row label="Password" hint={hint} keywords="sign in login credentials" dirty={dirty} disabled={!local}>
      <div className="input-wrap set-in">
        <input
          type={show ? "text" : "password"}
          value={password ?? ""}
          placeholder={isSet ? "Unchanged" : "Not set"}
          disabled={!local}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Password"
        />
        <IconButton label={show ? "Hide the password" : "Show the password"} size="sm" disabled={!local} onClick={() => setShow((v) => !v)}>
          {show ? <EyeOff /> : <Eye />}
        </IconButton>
      </div>
    </Row>
  );
}

export function WebUiSection() {
  const local = useStore((s) => !!s.app?.local);
  const error = useStore((s) => s.app?.webuiError ?? "");
  const savedOn = useStore((s) => !!s.prefs?.webui?.enabled);
  const isSet = useStore((s) => !!s.prefs?.webui?.passwordSet);
  const [enabled] = usePref<boolean>(W, "enabled");
  const [https] = usePref<boolean>(W, "https");
  const [password] = usePref<string>(W, "password");

  return (
    <Section
      id="webui"
      title="Web UI"
      icon={<Globe />}
      description="Use Promethea from a browser on another device: your phone, a laptop, a server you reach over a VPN."
    >
      {!local && (
        <div className="callout info set-callout">
          <Info />
          <span>You're using the web UI. Starting it, where it listens and its password can only be changed on the computer Promethea runs on.</span>
        </div>
      )}

      <Group title="Server">
        <SwitchPref k={[W, "enabled"]} label="Turn on the web UI" keywords="remote access browser" disabled={!local} hint={local ? undefined : LOCAL_ONLY} />
        {enabled && <AddressRow local={local} />}
        {enabled && savedOn && error && (
          <div className="set-row">
            <div className="callout error set-callout-row">
              <CircleAlert />
              <span>Not running: {error}</span>
            </div>
          </div>
        )}
        {enabled && <SwitchPref k={[W, "https"]} label="Use HTTPS" hint={local ? "Encrypts the connection. Needs a certificate and its key." : LOCAL_ONLY} keywords="tls ssl certificate secure" disabled={!local} sub />}
        {enabled && https && (
          <PathPref
            k={[W, "certPath"]}
            label="Certificate"
            keywords="https tls ssl pem"
            disabled={!local}
            file={{ title: "Choose the certificate", types: ["Certificates (*.pem;*.crt;*.cer)", "All files (*.*)"] }}
            sub
          />
        )}
        {enabled && https && (
          <PathPref
            k={[W, "keyPath"]}
            label="Private key"
            keywords="https tls ssl pem"
            disabled={!local}
            file={{ title: "Choose the private key", types: ["Keys (*.pem;*.key)", "All files (*.*)"] }}
            sub
          />
        )}
      </Group>

      <Group
        title="Signing in"
        note={enabled && !isSet && !password && local ? "Set a password to be able to sign in." : undefined}
      >
        <TextPref k={[W, "username"]} label="Username" keywords="sign in login" />
        <PasswordRow local={local} />
        <SwitchPref
          k={[W, "bypassLocalhost"]}
          label="Skip signing in on this computer"
          hint={local ? "Browsers on the computer Promethea runs on get in without the password." : LOCAL_ONLY}
          keywords="localhost bypass authentication"
          disabled={!local}
        />
      </Group>

      <Group title="Security">
        <NumberPref k={[W, "sessionTimeout"]} label="Sign out after" suffix="min idle" scale={60} min={1} keywords="session timeout expire" />
        <NumberPref k={[W, "maxAuthFailures"]} label="Block a device after" suffix="wrong passwords" min={1} max={100} keywords="ban brute force" />
        <NumberPref k={[W, "banDuration"]} label="Block it for" suffix="min" scale={60} min={0} keywords="ban duration" />
      </Group>
    </Section>
  );
}
