// Shapes of the data the Promethea backend sends (see promethea/engine/model.py and promethea/server.py).

export type TorrentState =
  | "downloading"
  | "metaDL"
  | "forcedMetaDL"
  | "forcedDL"
  | "stalledDL"
  | "queuedDL"
  | "stoppedDL"
  | "checkingDL"
  | "uploading"
  | "forcedUP"
  | "stalledUP"
  | "queuedUP"
  | "stoppedUP"
  | "checkingUP"
  | "checkingResumeData"
  | "moving"
  | "missingFiles"
  | "error"
  | "allocating"
  | "unknown";

export interface Torrent {
  id: string;
  name: string;
  state: TorrentState;
  progress: number;
  size: number;
  totalSize: number;
  completed: number;
  remaining: number;
  dlSpeed: number;
  upSpeed: number;
  eta: number;
  seeds: number;
  seedsTotal: number;
  peers: number;
  peersTotal: number;
  ratio: number;
  downloaded: number;
  uploaded: number;
  dlSession: number;
  upSession: number;
  category: string;
  tags: string[];
  savePath: string;
  currentPath: string;
  downloadPath: string;
  addedOn: number;
  completedOn: number;
  lastActivity: number;
  timeActive: number;
  seedingTime: number;
  seenComplete: number;
  availability: number;
  queue: number;
  dlLimit: number;
  upLimit: number;
  seqDl: boolean;
  firstLast: boolean;
  superSeeding: boolean;
  forceStart: boolean;
  autoTMM: boolean;
  tracker: string;
  trackerHosts: string[];
  connections: number;
  hasMetadata: boolean;
  private: boolean;
  error: string;
  ratioLimit: number;
  seedingTimeLimit: number;
  inactiveSeedingTimeLimit: number;
  effectiveRatioLimit: number;
  numFiles: number;
}

export type ConnectionStatus = "connected" | "firewalled" | "disconnected";

export interface ServerState {
  dlSpeed: number;
  upSpeed: number;
  dlSpeedTotal: number;
  upSpeedTotal: number;
  dlSession: number;
  upSession: number;
  dlAllTime: number;
  upAllTime: number;
  dhtNodes: number;
  peers: number;
  connection: ConnectionStatus;
  freeSpace: number;
  altSpeed: boolean;
  dlLimit: number;
  upLimit: number;
  listenPort: number;
  externalIp: string;
  wasted: number;
  diskQueue: number;
  diskJobs: number;
  uptime: number;
}

export interface Category {
  savePath: string;
  resolvedPath: string;
}

export type Categories = Record<string, Category>;

/** [unix seconds, download B/s, upload B/s] */
export type HistoryPoint = [number, number, number];

export interface FullSync {
  t: "full";
  torrents: Record<string, Torrent>;
  server: ServerState;
  categories: Categories;
  tags: string[];
  history: HistoryPoint[];
}

export interface DeltaSync {
  t: "delta";
  torrents?: Record<string, Partial<Torrent>>;
  removed?: string[];
  server?: Partial<ServerState>;
  categories?: Categories;
  tags?: string[];
  hist?: HistoryPoint;
}

export interface EventMessage {
  t: "event";
  name: string;
  data: any;
}

export type SocketMessage = FullSync | DeltaSync | EventMessage;

// ------------------------------------------------------------------ add flow
export interface TorrentFileInfo {
  index: number;
  path: string;
  size: number;
}

export interface InspectInfo {
  id: string;
  name: string;
  totalSize: number;
  files: TorrentFileInfo[];
  hasRootFolder: boolean;
  comment: string;
  createdBy: string;
  creationDate: number;
  private: boolean;
  pieceSize: number;
  numPieces: number;
  trackers: string[];
  webSeeds: string[];
  infohashV1: string;
  infohashV2: string;
  hasMetadata: boolean;
  token: string;
  alreadyAdded: boolean;
  existingName?: string;
  /** Private torrents don't take trackers from other sources. */
  existingPrivate?: boolean;
}

export type ContentLayout = "original" | "subfolder" | "noSubfolder";
export type StopCondition = "none" | "metadata" | "checked";

export interface AddOptions {
  savePath?: string | null;
  downloadPath?: string | null;
  useDownloadPath?: boolean | null;
  category?: string | null;
  tags?: string[];
  paused?: boolean | null;
  stopCondition?: StopCondition | null;
  sequential?: boolean;
  firstLast?: boolean;
  skipChecking?: boolean;
  contentLayout?: ContentLayout | null;
  addToTop?: boolean | null;
  autoTMM?: boolean | null;
  filePriorities?: Record<number, number> | number[] | null;
  renames?: Record<number, string> | null;
  name?: string | null;
  dlLimit?: number;
  upLimit?: number;
  ratioLimit?: number;
  seedingTimeLimit?: number;
  inactiveSeedingTimeLimit?: number;
}

export interface AddResult {
  added: string[];
  errors: { source: string; error: string }[];
  /** Already in the list: how many new trackers and web seeds it took from this source. */
  duplicates: { source: string; id: string; error: string; trackers?: number; webSeeds?: number }[];
}

// ------------------------------------------------------------------ details
export interface Properties {
  id: string;
  name: string;
  savePath: string;
  currentPath: string;
  downloadPath: string;
  comment: string;
  createdBy: string;
  creationDate: number;
  pieceSize: number;
  numPieces: number;
  piecesHave: number;
  totalSize: number;
  size: number;
  private: boolean;
  infohashV1: string;
  infohashV2: string;
  magnet: string;
  addedOn: number;
  completedOn: number;
  lastSeenComplete: number;
  timeActive: number;
  seedingTime: number;
  downloaded: number;
  dlSession: number;
  uploaded: number;
  upSession: number;
  wasted: number;
  connections: number;
  connectionsLimit: number;
  seeds: number;
  seedsTotal: number;
  peers: number;
  peersTotal: number;
  dlSpeed: number;
  upSpeed: number;
  dlSpeedAvg: number;
  upSpeedAvg: number;
  dlLimit: number;
  upLimit: number;
  ratio: number;
  reannounceIn: number;
  availability: number;
  error: string;
  hasMetadata: boolean;
  maxConnections: number;
  maxUploads: number;
}

export interface FileEntry {
  index: number;
  path: string;
  size: number;
  progress: number;
  priority: number;
  availability: number;
  firstPiece: number;
  lastPiece: number;
}

export interface FilesResponse {
  hasMetadata: boolean;
  files: FileEntry[];
}

export interface Peer {
  id: string;
  ip: string;
  port: number;
  client: string;
  connection: string;
  flags: string;
  progress: number;
  dlSpeed: number;
  upSpeed: number;
  downloaded: number;
  uploaded: number;
  seed: boolean;
  source: number;
}

export type TrackerStatus = "working" | "updating" | "notWorking" | "notContacted" | "disabled";

export interface TrackerEntry {
  url: string;
  tier: number;
  status: TrackerStatus;
  message: string;
  peers: number;
  seeds: number;
  leeches: number;
  downloaded: number;
  nextAnnounce: number;
  minAnnounce: number;
  pseudo: boolean;
}

export interface PiecesResponse {
  numPieces: number;
  pieceSize: number;
  piecesHave?: number;
  have: number[];
  downloading: number[];
  availability: number[];
}

// ------------------------------------------------------------------ app & prefs
export interface AppInfo {
  version: string;
  libtorrent: string;
  python: string;
  platform: string;
  local: boolean;
  desktop: boolean;
  webuiError: string;
  /** Whether /api/app/quit works for this client (desktop app locally, or a headless server). */
  canQuit?: boolean;
  dataDir?: string;
  fileAssociation?: boolean;
  autostart?: boolean;
}

export interface AuthState {
  authenticated: boolean;
  local: boolean;
  desktop: boolean;
  passwordSet: boolean;
  version: string;
}

export type Prefs = Record<string, Record<string, any>>;

export interface LogEntry {
  id: number;
  time: number;
  level: "info" | "warning" | "error";
  msg: string;
}

export interface BlockedPeer {
  time: number;
  ip: string;
  reason: string;
  /** Blocked this many times within a minute of `time`, the latest at `last`. */
  count: number;
  last: number;
}

export interface CreatorJob {
  id: string;
  source: string;
  output: string;
  status: "running" | "done" | "error" | "cancelled";
  progress: number;
  error: string;
  numPieces: number;
  pieceSize: number;
  /** Unix time it was started. */
  started: number;
  /** It's to be added to the transfers, seeding, once it's made. */
  seed: boolean;
}

/** What a torrent made from a file or folder would hold, worked out without hashing it. */
export interface CreatorSource {
  name: string;
  isDir: boolean;
  /** Files that go in: hidden ones in a folder are left out. */
  files: number;
  size: number;
  pieceSize: number;
  numPieces: number;
  /** The folder was too big to list in a few seconds: counts so far, and no pieces. */
  partial: boolean;
}

export type TorrentFormat = "hybrid" | "v1" | "v2";

export interface CreatorOptions {
  format: TorrentFormat;
  /** Bytes; 0 picks one from the size. */
  pieceSize: number;
  private: boolean;
  startSeeding: boolean;
  /** When seeding it: no ratio or seeding time limits. */
  ignoreShareLimits: boolean;
  /** One per line; a blank line starts a new tier. */
  trackers: string;
  urlSeeds: string;
  comment: string;
  /** The info dict's "source" field, which some private trackers ask for. */
  source: string;
}

// ------------------------------------------------------------------ search
export interface SearchPlugin {
  /** File name without .py; what the API calls it. */
  name: string;
  fullName: string;
  version: string;
  url: string;
  categories: string[];
  enabled: boolean;
  /** A data: URL, when the plugin came with an icon. */
  icon: string | null;
  /** Set when the plugin failed to load. */
  error: string | null;
}

export interface SearchResult {
  name: string;
  link: string;
  /** Bytes; -1 when the site doesn't say. */
  size: number;
  /** -1 when unknown. */
  seeds: number;
  leechers: number;
  engineUrl: string;
  descLink: string;
  /** Unix seconds; 0 when unknown. */
  pubDate: number;
  plugin: string;
}

export type SearchStatus = "running" | "finished" | "stopped" | "error";

export interface SearchError {
  plugin: string;
  message: string;
}

export interface SearchSummary {
  id: string;
  query: string;
  category: string;
  status: SearchStatus;
  total: number;
}

export interface SearchDetails extends SearchSummary {
  /** From the requested offset on. */
  results: SearchResult[];
  errors: SearchError[];
  plugins: string[];
}

export interface PluginUpdate {
  name: string;
  installed: string;
  available: string;
}

export interface PluginUpdateResult {
  name: string;
  ok: boolean;
  version: string | null;
  error: string | null;
}

// ------------------------------------------------------------------ rss
export interface RssFeed {
  id: string;
  /** The name given to it, else the feed's own title, else its address. */
  name: string;
  url: string;
  /** "" at the top, "TV/Anime" inside folders. */
  folder: string;
  title: string;
  lastUpdated: number;
  loading: boolean;
  error: string | null;
  unread: number;
  total: number;
}

export interface RssSnapshot {
  feeds: RssFeed[];
  folders: string[];
}

export interface RssArticle {
  id: string;
  title: string;
  /** The article's web page. */
  link: string;
  /** .torrent address or magnet link; "" when the article has none. */
  torrentUrl: string;
  /** Text or HTML from the feed: sanitize before showing it. */
  description: string;
  date: number;
  read: boolean;
  author: string;
}

export interface RssRule {
  name: string;
  enabled: boolean;
  mustContain: string;
  mustNotContain: string;
  useRegex: boolean;
  episodeFilter: string;
  smartFilter: boolean;
  /** Addresses of the feeds it watches. */
  affectedFeeds: string[];
  ignoreDays: number;
  lastMatch: number;
  previouslyMatchedEpisodes: string[];
  /** null: as the settings say. */
  addPaused: boolean | null;
  category: string;
  tags: string[];
  savePath: string;
  contentLayout: ContentLayout | null;
  priority: number;
}

export interface RssMatch {
  feedId: string;
  articleId: string;
  title: string;
  /** Unread ones with a torrent are downloaded when the rule is saved (with automatic downloading on). */
  read: boolean;
  hasTorrent: boolean;
}
