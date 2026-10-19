import { Share2 } from "lucide-react";
import { CheckNumberPref, Group, LimitPref, NumberPref, Section, SelectPref, SwitchPref, TextareaPref } from "../controls";
import { usePref } from "../draft";

const T = "bittorrent";

export function BitTorrentSection() {
  const [queueing] = usePref<boolean>(T, "queueing");
  const [skipSlow] = usePref<boolean>(T, "dontCountSlow");
  const [extraTrackers] = usePref<boolean>(T, "addTrackersEnabled");
  return (
    <Section id="bittorrent" title="BitTorrent" icon={<Share2 />}>
      <Group title="Finding peers">
        <SwitchPref k={[T, "dht"]} label="DHT" hint="Finds peers without a tracker. Needed for most magnet links." keywords="distributed hash table trackerless" />
        <SwitchPref k={[T, "pex"]} label="Peer exchange" hint="Peers tell each other about more peers." keywords="pex" />
        <SwitchPref k={[T, "lsd"]} label="Local peer discovery" hint="Finds peers on your own network." keywords="lsd lan" />
      </Group>

      <Group title="Privacy">
        <SelectPref
          k={[T, "encryption"]}
          label="Encryption"
          hint="Requiring it leaves out the peers that don't support it."
          keywords="obfuscation protocol"
          options={[
            { value: "prefer", label: "Prefer encrypted" },
            { value: "require", label: "Require encryption" },
            { value: "disable", label: "Don't encrypt" },
          ]}
        />
        <SwitchPref
          k={[T, "anonymousMode"]}
          label="Anonymous mode"
          hint="Doesn't tell peers and trackers which client this is. Some private trackers refuse it."
          keywords="privacy fingerprint user agent"
        />
      </Group>

      <Group title="Queue">
        <SwitchPref
          k={[T, "queueing"]}
          label="Run only some torrents at a time"
          hint="The rest wait in the queue until there's room."
          keywords="queueing active maximum"
        />
        {queueing && <LimitPref k={[T, "maxActiveDownloads"]} label="Downloading at once" keywords="queue active maximum" sub />}
        {queueing && <LimitPref k={[T, "maxActiveUploads"]} label="Seeding at once" keywords="queue active maximum uploads" sub />}
        {queueing && <LimitPref k={[T, "maxActiveTorrents"]} label="Active in total" keywords="queue active maximum" sub />}
        {queueing && (
          <SwitchPref
            k={[T, "dontCountSlow"]}
            label="Don't count slow torrents"
            hint="Torrents that stay below these speeds don't take a place in the queue."
            keywords="queue inactive"
            sub
          />
        )}
        {queueing && skipSlow && <NumberPref k={[T, "slowDlRate"]} label="Download speed below" suffix="KiB/s" min={0} keywords="slow inactive" sub />}
        {queueing && skipSlow && <NumberPref k={[T, "slowUpRate"]} label="Upload speed below" suffix="KiB/s" min={0} keywords="slow inactive" sub />}
        {queueing && skipSlow && (
          <NumberPref k={[T, "slowInactivityTimer"]} label="For at least" suffix="s" min={1} keywords="slow inactivity timer" sub />
        )}
        <NumberPref
          k={[T, "maxActiveChecking"]}
          label="Torrents checked at the same time"
          hint="Checking reads all of a torrent's data; more at once is slower on hard drives."
          keywords="hash check verify"
          min={1}
          max={64}
        />
      </Group>

      <Group title="Seeding limits" note="Each torrent can override these in Limits & sharing.">
        <CheckNumberPref on={[T, "ratioLimitEnabled"]} k={[T, "ratioLimit"]} label="When the ratio reaches" keywords="share ratio seed" min={0} step={0.1} float />
        <CheckNumberPref
          on={[T, "seedingTimeLimitEnabled"]}
          k={[T, "seedingTimeLimit"]}
          label="After seeding for"
          keywords="seeding time"
          suffix="min"
          min={1}
        />
        <CheckNumberPref
          on={[T, "inactiveSeedingTimeLimitEnabled"]}
          k={[T, "inactiveSeedingTimeLimit"]}
          label="After seeding without uploading for"
          keywords="inactive seeding time idle"
          suffix="min"
          min={1}
        />
        <SelectPref
          k={[T, "seedingLimitAction"]}
          label="Then"
          keywords="seeding limit action"
          options={[
            { value: "stop", label: "Stop the torrent" },
            { value: "remove", label: "Remove the torrent" },
            { value: "removeWithFiles", label: "Remove it and its files" },
            { value: "superSeeding", label: "Switch to super seeding" },
          ]}
        />
      </Group>

      <Group title="Extra trackers">
        <SwitchPref
          k={[T, "addTrackersEnabled"]}
          label="Add these trackers to new torrents"
          hint="Private torrents keep to their own trackers."
          keywords="public trackers list announce"
        />
        {extraTrackers && (
          <TextareaPref
            k={[T, "addTrackers"]}
            label="Trackers"
            hint="One URL per line."
            keywords="announce url"
            placeholder="udp://tracker.example.org:1337/announce"
            rows={5}
            sub
          />
        )}
      </Group>
    </Section>
  );
}
