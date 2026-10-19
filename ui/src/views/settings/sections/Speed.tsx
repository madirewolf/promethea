import { Gauge } from "lucide-react";
import { Input } from "../../../components/ui/Form";
import { Group, Row, Section, SelectPref, SpeedPref, SwitchPref } from "../controls";
import { usePref } from "../draft";

const S = "speed";

function ScheduleTimes() {
  const [from, setFrom, fromDirty] = usePref<string>(S, "scheduleFrom");
  const [to, setTo, toDirty] = usePref<string>(S, "scheduleTo");
  return (
    <Row label="Between" hint="A range past midnight works too, like 22:00 to 07:00." keywords="schedule time from to hours" dirty={fromDirty || toDirty} sub>
      <div className="set-pair">
        <Input className="set-time" type="time" value={from ?? ""} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="From" />
        <span className="muted">and</span>
        <Input className="set-time" type="time" value={to ?? ""} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="To" />
      </div>
    </Row>
  );
}

export function SpeedSection() {
  const [scheduled] = usePref<boolean>(S, "scheduleEnabled");
  return (
    <Section id="speed" title="Speed" icon={<Gauge />}>
      <Group title="Limits" note="For all torrents together. Leave a box empty for no limit.">
        <SpeedPref k={[S, "dlLimit"]} label="Download" keywords="limit rate global" />
        <SpeedPref k={[S, "upLimit"]} label="Upload" keywords="limit rate global" />
      </Group>

      <Group title="Alternative limits" note="Switch to these from the status bar, or on a schedule.">
        <SpeedPref k={[S, "altDlLimit"]} label="Download" keywords="alternative alt limit rate turtle slow" />
        <SpeedPref k={[S, "altUpLimit"]} label="Upload" keywords="alternative alt limit rate turtle slow" />
        <SwitchPref k={[S, "altEnabled"]} label="Use the alternative limits now" keywords="alternative alt turtle slow" />
        <SwitchPref k={[S, "scheduleEnabled"]} label="Use them on a schedule" keywords="alternative alt schedule time" />
        {scheduled && <ScheduleTimes />}
        {scheduled && (
          <SelectPref
            k={[S, "scheduleDays"]}
            label="On"
            keywords="schedule days weekdays weekends"
            sub
            options={[
              { value: "every", label: "Every day" },
              { value: "weekdays", label: "Weekdays" },
              { value: "weekends", label: "Weekends" },
              { value: "mon", label: "Mondays" },
              { value: "tue", label: "Tuesdays" },
              { value: "wed", label: "Wednesdays" },
              { value: "thu", label: "Thursdays" },
              { value: "fri", label: "Fridays" },
              { value: "sat", label: "Saturdays" },
              { value: "sun", label: "Sundays" },
            ]}
          />
        )}
      </Group>

      <Group title="What the limits apply to">
        <SwitchPref k={[S, "limitUtp"]} label="µTP connections" keywords="utp limit" />
        <SwitchPref k={[S, "limitOverhead"]} label="Protocol overhead" hint="Count TCP/IP headers toward the limits." keywords="overhead transport" />
        <SwitchPref k={[S, "limitLan"]} label="Peers on your local network" keywords="lan local" />
      </Group>
    </Section>
  );
}
