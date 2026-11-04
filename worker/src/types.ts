export interface Env {
  AI: Ai;
  DB: D1Database;
  VEC: VectorizeIndex;
  FILES: R2Bucket;
  ANSWER_MODEL: string;
  PUBLIC_BASE_URL: string;
  ANTHROPIC_API_KEY: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  LINK_SECRET: string;
  API_TOKEN: string;
}

// A serial number the pilot typed in the question (no fleet data is stored).
export interface SerialContext { serial: string; group: "LOW_OR_LOW_SB" | "HIGH" }
