export interface D1Result<T = any> { results: T[]; success: boolean; meta: any }
export interface D1Stmt { bind(...v: any[]): D1Stmt; first<T = any>(): Promise<T | null>; all<T = any>(): Promise<D1Result<T>>; run(): Promise<D1Result> }
export interface D1DB { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<D1Result[]> }
export interface R2Obj { key: string; size: number; body: ReadableStream; httpMetadata?: { contentType?: string }; etag?: string }
export interface R2B {
  put(key: string, v: ArrayBuffer | string, o?: any): Promise<any>;
  get(key: string): Promise<R2Obj | null>;
  delete(k: string | string[]): Promise<void>;
  list(o?: any): Promise<any>;
}
export type Env = {
  DB: D1DB; FILES: R2B;
  BOT_TOKEN: string; WEBHOOK_SECRET: string; ADMIN_TELEGRAM_IDS: string; DOWNLOAD_SIGNING_KEY: string;
  ALLOWED_ORIGIN: string; WEBAPP_URL: string; ADMIN_URL: string;
  INITDATA_MAX_AGE?: string; MAX_FILE_MB?: string; MAX_IMAGE_MB?: string; LINK_TTL_SECONDS?: string;
};
export type TgUser = { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string };
export type Ctx = {
  req: Request; env: Env; url: URL; params: string[]; wait: (p: Promise<any>) => void;
  user?: TgUser; isAdmin?: boolean;
};
