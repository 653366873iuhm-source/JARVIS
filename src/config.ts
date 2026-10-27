import { z } from "zod";

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const num = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? d : Number(v)));
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const addrList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
  );

export const ConfigSchema = z.object({
  NODE_ENV: z.string().default("development"),
  ROLE: z.enum(["api", "worker", "all"]).default("all"),
  PORT: num(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  // ---- database
  DATABASE_URL: z.string().default("file:./data/agentpad.db"), // postgres://... or file:... (SQLite/libSQL)
  DB_AUTO_MIGRATE: bool(true),

  // ---- chain
  RPC_URL: z.string().default("http://127.0.0.1:8545"),
  CHAIN_ID: num(31337),
  REGISTRY_ADDRESS: addr.optional(),
  FACTORY_ADDRESS: addr.optional(),
  REWARD_POOL_ADDRESS: addr.optional(),
  FEE_SPLITTER_ADDRESS: addr.optional(),
  DEPLOYMENTS_FILE: z.string().optional(), // alternative: JSON {contracts:{AgentRegistry,...}} from deploy script
  START_BLOCK: num(0),
  CONFIRMATIONS: num(0),
  INDEXER_BATCH_BLOCKS: num(2000),
  INDEXER_POLL_MS: num(3000),

  // ---- signer (platform signer = AgentRegistry.platformSigner)
  // keystore = encrypted JSON keystore (ethers/geth v3 format) + password from env or a secret file (production default)
  // kms      = AWS KMS secp256k1 key (needs @aws-sdk/client-kms installed)
  // local    = raw private key from env (development/tests only; refused when NODE_ENV=production)
  SIGNER_KIND: z.enum(["local", "keystore", "kms"]).default("local"),
  SIGNER_PRIVATE_KEY: z.string().optional(),
  SIGNER_KEYSTORE_FILE: z.string().optional(),
  SIGNER_KEYSTORE_JSON: z.string().optional(), // keystore JSON inline (e.g. a platform secret); still password-encrypted
  SIGNER_KEYSTORE_PASSWORD: z.string().optional(),
  SIGNER_KEYSTORE_PASSWORD_FILE: z.string().optional(), // e.g. /run/secrets/signer_password (preferred over the env var)
  // relayer pays gas for relayable txs (submitPromotion/graduate/register relay); defaults to the signer
  RELAYER_KIND: z.enum(["same", "local", "keystore", "kms"]).default("same"),
  RELAYER_PRIVATE_KEY: z.string().optional(),
  RELAYER_KEYSTORE_FILE: z.string().optional(),
  RELAYER_KEYSTORE_JSON: z.string().optional(),
  RELAYER_KEYSTORE_PASSWORD: z.string().optional(),
  RELAYER_KEYSTORE_PASSWORD_FILE: z.string().optional(),
  KMS_KEY_ID: z.string().optional(),
  KMS_REGION: z.string().optional(),
  RELAYER_KMS_KEY_ID: z.string().optional(),
  // master switch for every platform transaction (relays, submitPromotion/graduate, postRoot, revoke/remove).
  // false = read-only deployment: txs are only recorded as "prepared" (GET /v1/admin/txs), nothing is broadcast.
  TX_SEND_ENABLED: bool(true),
  AUTO_SUBMIT_ADMIN_TXS: bool(true), // revokeLaunch / removeAgent / postRoot sent immediately; false = only prepared (admin_txs)

  // ---- platform addresses excluded from promotion share (treasury etc.)
  PLATFORM_ADDRESSES: addrList,

  // ---- admin
  ADMIN_TOKEN: z.string().default("change-me"),

  // ---- HTTP
  // comma-separated allowed browser origins, e.g. "https://agentpad.vercel.app,https://*.vercel.app"; "*" = any.
  // Default: any origin outside production, PUBLIC_APP_URL's origin in production.
  CORS_ORIGINS: z.string().optional(),
  PUBLIC_APP_URL: z.string().default("http://localhost:5173"), // frontend base URL (share links)

  // ---- NFT metadata (collection.json + per-token traits)
  IPFS_GATEWAY: z.string().default("https://ipfs.io/ipfs/"),
  METADATA_POLL_MS: num(15000),
  METADATA_FETCH_TIMEOUT_MS: num(8000),

  // ---- X (Twitter)
  // No paid X API: public lookups via FxTwitter (posts are submitted by URL, never searched). mock = in-memory (tests).
  X_PROVIDER: z.enum(["fxtwitter", "mock"]).default("fxtwitter"),
  FXTWITTER_BASE_URL: z.string().default("https://api.fxtwitter.com"),
  FXTWITTER_MIN_INTERVAL_MS: num(1000), // ~1 req/s
  FXTWITTER_CACHE_TTL_SEC: num(300),
  FXTWITTER_MAX_RETRIES: num(3),

  // ---- eligibility (launch)
  ELIG_MIN_FOLLOWERS: num(5000),
  ELIG_MIN_ACCOUNT_AGE_DAYS: num(90),
  ELIG_MIN_POSTS_30D: num(10),
  ELIG_MIN_ENGAGEMENT_BPS: num(50), // 0.5% = 50 bps
  ELIG_MAX_POST_URLS: num(50), // max eligibility post URLs accepted per submission
  REQUALIFY_INTERVAL_DAYS: num(30),
  REGISTRATION_TTL_DAYS: num(365),
  CHALLENGE_TTL_MIN: num(30),

  // ---- Agent ID (.ai) resolver
  AGENTID_PROVIDER: z.enum(["binance-http", "binance-cli", "mock"]).default("mock"),
  BINANCE_API_BASE: z.string().default("https://www.binance.com"),
  BINANCE_AGENT_SESSION_ID: z.string().optional(),
  BINANCE_CHAIN_ID: z.string().default("56"),
  BAW_BIN: z.string().default("baw"),

  // ---- promotion gate
  PROMO_POLL_MS: num(30000),
  PROMO_SIMILARITY_THRESHOLD: num(0.8),
  PROMO_RESUBMIT_MIN_SEC: num(900),
  PROMO_FINAL_SUBMIT_SEC: num(600), // submit last below-threshold root when < this many seconds remain
  CODE_SECRET: z.string().default("dev-code-secret-change-me"),

  // ---- rewards
  REWARD_CRON: z.string().default("10 0 * * *"), // UTC
  REWARD_MAX_POSTS_PER_AGENT_DAY: num(3),
  REFERRAL_WINDOW_SEC: num(86400),

  // ---- sybil
  FUNDING_PROVIDER: z.enum(["etherscan", "rpc-scan", "mock"]).default("rpc-scan"),
  ETHERSCAN_API_URL: z.string().default("https://api.etherscan.io/v2/api"),
  ETHERSCAN_API_KEY: z.string().optional(),
  SYBIL_MIN_CLUSTER: num(3),
  SYBIL_EXEMPT_FUNDERS: addrList,
  SYBIL_CRON: z.string().default("17 * * * *"),
  REQUALIFY_CRON: z.string().default("40 1 * * *"),
});

export type Config = z.infer<typeof ConfigSchema>;

const DEV_DEFAULTS: Partial<Record<keyof Config, string>> = { ADMIN_TOKEN: "change-me", CODE_SECRET: "dev-code-secret-change-me" };

/**
 * Production guard (NODE_ENV=production): fail fast instead of running with a plaintext key in the environment or
 * with development secrets.
 */
export function assertProductionSafe(cfg: Config): void {
  if (cfg.NODE_ENV !== "production") return;
  const errs: string[] = [];
  if (cfg.SIGNER_KIND === "local") errs.push("SIGNER_KIND=local (raw private key) is not allowed in production: use keystore or kms");
  if (cfg.SIGNER_PRIVATE_KEY) errs.push("SIGNER_PRIVATE_KEY must not be set in production (plaintext key in env)");
  if (cfg.RELAYER_PRIVATE_KEY || cfg.RELAYER_KIND === "local") errs.push("RELAYER_PRIVATE_KEY / RELAYER_KIND=local are not allowed in production: use RELAYER_KIND=keystore|kms|same");
  for (const k of Object.keys(DEV_DEFAULTS)) {
    const v = String((cfg as any)[k] ?? "");
    if (v === (DEV_DEFAULTS as any)[k] || /change-me/i.test(v) || v.length < 16) errs.push(`${k} still has a development/placeholder value (use >= 16 random chars)`);
  }
  if (errs.length) throw new Error(`Refusing to start in production:\n - ${errs.join("\n - ")}`);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cfg = ConfigSchema.parse(env);
  assertProductionSafe(cfg);
  return cfg;
}
