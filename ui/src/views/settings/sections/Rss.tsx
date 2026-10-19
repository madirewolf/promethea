import { Rss } from "lucide-react";
import { Group, LinesPref, NumberPref, Section, SwitchPref } from "../controls";
import { usePref } from "../draft";

const R = "rss";

export function RssSection() {
  const [fetching] = usePref<boolean>(R, "fetchEnabled");
  return (
    <Section id="rss" title="RSS" icon={<Rss />}>
      <Group title="Feeds">
        <SwitchPref k={[R, "fetchEnabled"]} label="Check feeds for new articles" keywords="fetch refresh update" />
        {fetching && <NumberPref k={[R, "refreshInterval"]} label="Every" suffix="min" min={1} keywords="refresh interval" sub />}
        <NumberPref k={[R, "maxArticles"]} label="Articles kept per feed" min={1} max={10000} keywords="history maximum" />
      </Group>

      <Group title="Downloading">
        <SwitchPref
          k={[R, "autoDownload"]}
          label="Download new articles that match a rule"
          hint="Rules are made in the RSS view."
          keywords="automatic downloader rules"
        />
        <SwitchPref
          k={[R, "downloadRepacks"]}
          label="Also download PROPER and REPACK releases"
          hint="Of episodes a rule has already downloaded."
          keywords="repack proper episode"
        />
        <LinesPref
          k={[R, "smartFilters"]}
          label="Episode patterns"
          hint="Regular expressions that find the episode in a title, so rules with the smart filter download each episode once."
          keywords="smart episode filter regex"
          rows={4}
        />
      </Group>
    </Section>
  );
}
