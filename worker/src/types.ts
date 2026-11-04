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

export interface Aircraft { tail: string; serial: string; serial_group: string; notes: string | null }
